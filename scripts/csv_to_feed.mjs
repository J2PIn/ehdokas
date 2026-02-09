import fs from "node:fs";
import path from "node:path";

function parseCSV(text) {
  // Supports quoted fields + commas inside quotes
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((x) => x.trim().length)) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some((x) => x.trim().length)) rows.push(row);

  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (r[idx] ?? "").trim()));
    return obj;
  });
}

function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

const CSV_PATH = process.argv[2] || "public/elections/fi-next/candidates.csv";
const OUT_PATH = process.argv[3] || "public/elections/fi-next/feed.json";

// Set these per election (or pass via env)
const electionDay = process.env.ELECTION_DAY || "2026-12-31";
const electionName = process.env.ELECTION_NAME || "Seuraavat vaalit (beta)";
const jurisdiction = process.env.JURISDICTION || "Finland";

const csvText = fs.readFileSync(CSV_PATH, "utf8");
const rows = parseCSV(csvText);

// Expected columns: id,name,party,photoUrl(optional),website(optional)
const candidatesRaw = rows.map((r) => {
  const id = r.id;
  const name = r.name;
  if (!nonEmpty(id) || !nonEmpty(name)) return null;

  return {
    id: id.trim(),
    name: name.trim(),
    party: nonEmpty(r.party) ? r.party.trim() : undefined,
    photoUrl: nonEmpty(r.photoUrl) ? r.photoUrl.trim() : undefined,
    website: nonEmpty(r.website) ? r.website.trim() : undefined,
    disclosures: {}, // important: exists even if empty
  };
}).filter(Boolean);

const candidates = uniqBy(candidatesRaw, (c) => c.id);

const feed = {
  schemaVersion: 1,
  jurisdiction,
  electionName,
  electionDay,
  lastUpdated: new Date().toISOString(),
  candidates,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(feed, null, 2) + "\n", "utf8");

console.log(`✅ Wrote ${OUT_PATH}`);
console.log(`Candidates: ${candidates.length} (from ${candidatesRaw.length})`);
