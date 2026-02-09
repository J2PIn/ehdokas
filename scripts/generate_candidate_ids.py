#!/usr/bin/env python3
import csv
import re
import sys
import unicodedata
from pathlib import Path

CSV_PATH = Path("public/elections/fi-next/candidates.csv")

def slugify(s: str) -> str:
    s = (s or "").strip().lower()

    # Common Finnish letters (do this BEFORE ascii normalize so we preserve intent)
    s = s.replace("å", "a").replace("ä", "a").replace("ö", "o")

    # Normalize & strip accents
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))

    # Keep alnum, turn everything else into '-'
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-{2,}", "-", s).strip("-")

    return s or "candidate"

def main():
    if not CSV_PATH.exists():
        print(f"ERROR: file not found: {CSV_PATH}", file=sys.stderr)
        sys.exit(1)

    with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows = list(reader)

    required = ["id", "name", "party", "photoUrl", "website"]
    missing_cols = [c for c in required if c not in fieldnames]
    if missing_cols:
        print(f"ERROR: missing columns: {missing_cols}", file=sys.stderr)
        print(f"Found columns: {fieldnames}", file=sys.stderr)
        sys.exit(1)

    used = set()
    # pre-seed used with any existing ids
    for r in rows:
        existing = (r.get("id") or "").strip()
        if existing:
            used.add(existing)

    changed = 0
    for r in rows:
        cur = (r.get("id") or "").strip()
        name = (r.get("name") or "").strip()
        if not name:
            print("ERROR: row missing name; cannot generate id", file=sys.stderr)
            print(r, file=sys.stderr)
            sys.exit(1)

        if not cur:
            base = slugify(name)
            cand = base
            i = 2
            while cand in used:
                cand = f"{base}-{i}"
                i += 1
            r["id"] = cand
            used.add(cand)
            changed += 1
        else:
            # Ensure uniqueness even if user-provided IDs collide
            if cur in used:
                # It's in used because we seeded; ok, but ensure no duplicates across rows:
                pass

    # Detect duplicates after assignment
    counts = {}
    for r in rows:
        rid = (r.get("id") or "").strip()
        counts[rid] = counts.get(rid, 0) + 1
    dups = [k for k, v in counts.items() if v > 1]
    if dups:
        print(f"ERROR: duplicate ids found: {dups[:20]}{'...' if len(dups)>20 else ''}", file=sys.stderr)
        sys.exit(1)

    # Write back (utf-8)
    tmp = CSV_PATH.with_suffix(".csv.tmp")
    with tmp.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(CSV_PATH)

    print(f"OK: generated ids for {changed} rows (file updated): {CSV_PATH}")

if __name__ == "__main__":
    main()
