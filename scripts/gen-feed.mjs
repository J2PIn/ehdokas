// scripts/gen-feed.mjs
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

const csvPath = path.resolve("public/elections/fi-next/candidates.csv");
const outPath = path.resolve("public/elections/fi-next/feed.json");

function mustExist(p) {
  if (!fs.existsSync(p)) throw new Error(`[FEED] Missing file: ${p}`);
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

mustExist(csvPath);

const raw = stripBom(fs.readFileSync(csvPath, "utf8"));

const records = parse(raw, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

if (!records.length) {
  throw new Error(`[FEED] Parsed 0 rows from ${csvPath}. Check delimiter/headers/BOM.`);
}

const requiredCols = ["id", "name", "party"];
const cols = Object.keys(records[0] ?? {});
for (const c of requiredCols) {
  if (!cols.includes(c)) {
    throw new Error(`[FEED] Missing required column "${c}". Found: ${cols.join(", ")}`);
  }
}

const candidates = records
  .map((r) => ({
    id: (r.id ?? "").trim(),
    name: (r.name ?? "").trim(),
    party: (r.party ?? "").trim(),
    photoUrl: (r.photoUrl ?? "").trim() || undefined,
    website: (r.website ?? "").trim() || undefined,
    disclosures: {}, // default
  }))
 

if (!candidates.length) {
  // HARD FAIL: never write a fallback
  throw new Error(
    `[FEED] After filtering, 0 valid candidates. Ensure each row has id,name,party. Refusing to write fallback feed.`
  );
}

// Safety: never ship test candidate
if (candidates.some((c) => c.id.startsWith("test"))) {
  throw new Error(`[FEED] Found candidate id starting with "test". Aborting.`);
}

const feed = {
  schemaVersion: 1,
  jurisdiction: "Finland",
  electionName: "Seuraavat vaalit (beta)",
  electionDay: "2027-4-18",
  lastUpdated: new Date().toISOString(),
  candidates,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(feed, null, 2) + "\n", "utf8");

console.log(`[FEED] Wrote ${outPath}`);
console.log(`[FEED] Candidates: ${candidates.length} (from ${records.length})`);
