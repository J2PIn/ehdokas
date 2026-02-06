import React, { useEffect, useState } from "react";

type ElectionIndex = {
  schemaVersion: 1;
  jurisdiction: string;
  lastUpdated: string;
  elections: Array<{
    id: string;
    name: string;
    electionDay: string;
    feedUrl: string;
    lastUpdated?: string;
  }>;
};

export default function App() {
  const [index, setIndex] = useState<ElectionIndex | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/elections/index.json", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return (await r.json()) as ElectionIndex;
      })
      .then(setIndex)
      .catch((e) => setErr(e?.message ?? "Failed to load"));
  }, []);

  return (
    <div style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>ehdokas.site</h1>
      <p>Openness tracker (static, no storage)</p>

      {err && <pre>{err}</pre>}

      {index && (
        <>
          <p>
            <b>{index.jurisdiction}</b> • last updated {index.lastUpdated}
          </p>
          <ul>
            {index.elections.map((e) => (
              <li key={e.id}>
                {e.electionDay} — {e.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
