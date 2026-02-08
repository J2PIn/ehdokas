import fs from "node:fs";
import path from "node:path";

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(","); // simple CSV (no quoted commas)
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = (cols[idx] ?? "").trim()));
    rows.push(obj);
  }
  return rows;
}

function nonEmpty(x) {
  return typeof x === "string" && x.trim().length > 0;
}

const csvPath = process.argv[2] || "public/elections/fi-next/candidates.csv";
const outPath = process.argv[3] || "public/elections/fi-next/feed.json";

// ⬇️ set these once per election
const electionDay = process.env.ELECTION_DAY || "2026-12-31";
const electionName = process.env.ELECTION_NAME || "Seuraavat vaalit (beta)";
const jurisdiction = process.env.JURISDICTION || "Suomi";

const csv = fs.readFileSync(csvPath, "utf8");
const rows = parseCSV(csv);

const candidates = rows.map((r) => ({
  id: r.id,
  name: r.name,
  party: r.party || undefined,
  photoUrl: nonEmpty(r.photoUrl) ? r.photoUrl : undefined,
  website: nonEmpty(r.website) ? r.website : undefined,
  disclosures: {}, // important: exists even if empty (search/ranking still includes them)
}));

const feed = {
  schemaVersion: 1,
  jurisdiction,
  electionName,
  electionDay,
  lastUpdated: new Date().toISOString(),
  candidates,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(feed, null, 2) + "\n", "utf8");

console.log(`Wrote ${outPath} with ${candidates.length} candidates`);
