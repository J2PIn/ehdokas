import React from "react";
import {
  canonicalStringify,
  randomToken,
  sha256Bytes,
  sha256Text,
} from "../lib/crypto";

type DocInput = {
  url: string;
  label: string;
  mime: string;
};

type Manifest = {
  schema: "ehdokas.disclosure.v1";
  candidateId: string;
  issuer: string; // URL like https://candidate.fi
  createdAt: string; // ISO
  docs: Array<{
    url: string;
    sha256: string; // hex
    label: string;
    mime?: string;
  }>;
  domainProof?: {
    method: "well-known";
    url: string; // https://issuer/.well-known/ehdokas.txt
    token: string;
    verifiedAt?: string;
  };
};

function normalizeIssuer(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  // remove trailing slash
  s = s.replace(/\/+$/, "");
  return s;
}

async function fetchNoCache(url: string): Promise<Response> {
  const u = new URL(url);
  u.searchParams.set("_", Date.now().toString());
  return fetch(u.toString(), {
    method: "GET",
    cache: "no-store",
  });
}

async function hashRemoteFile(url: string): Promise<{ sha256: string; size: number }> {
  // We intentionally fetch directly from candidate domain (no proxy),
  // so the candidate’s server must allow public GET (+ ideally CORS).
  const res = await fetchNoCache(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sha = await sha256Bytes(bytes);
  return { sha256: sha, size: bytes.byteLength };
}

export default function Disclose() {
  const [candidateId, setCandidateId] = React.useState("");
  const [issuer, setIssuer] = React.useState("");
  const issuerNorm = normalizeIssuer(issuer);

  // Domain proof
  const [domainToken, setDomainToken] = React.useState("");
  const proofUrl = issuerNorm ? `${issuerNorm}/.well-known/ehdokas.txt` : "";
  const [domainStatus, setDomainStatus] = React.useState<
    "idle" | "generated" | "verifying" | "verified" | "failed"
  >("idle");
  const [domainError, setDomainError] = React.useState<string | null>(null);
  const [domainVerifiedAt, setDomainVerifiedAt] = React.useState<string | null>(null);

  // Documents
  const [docs, setDocs] = React.useState<DocInput[]>([
    { url: "", label: "", mime: "application/pdf" },
  ]);
  const [hashing, setHashing] = React.useState(false);
  const [docResults, setDocResults] = React.useState<
    Array<{ sha256: string; size: number; error?: string }>
  >([]);

  // Manifest outputs
  const [manifestText, setManifestText] = React.useState<string>("");
  const [manifestSha, setManifestSha] = React.useState<string>("");

  function resetOutputs() {
    setDocResults([]);
    setManifestText("");
    setManifestSha("");
  }

  function onGenerateToken() {
    resetOutputs();
    const t = randomToken(16);
    setDomainToken(t);
    setDomainStatus("generated");
    setDomainError(null);
    setDomainVerifiedAt(null);
  }

  async function onVerifyDomain() {
    if (!proofUrl || !domainToken) return;
    setDomainStatus("verifying");
    setDomainError(null);
    try {
      const res = await fetchNoCache(proofUrl);
      if (!res.ok) throw new Error(`Fetch failed (${res.status}). Is the file public?`);
      const txt = (await res.text()).trim();
      const expected = `ehdokas-domain-proof=${domainToken}`;
      if (txt !== expected) {
        throw new Error(
          `Token mismatch.\nExpected exactly:\n${expected}\n\nGot:\n${txt || "(empty)"}`
        );
      }
      const now = new Date().toISOString();
      setDomainVerifiedAt(now);
      setDomainStatus("verified");
    } catch (e: any) {
      setDomainStatus("failed");
      setDomainError(e?.message || String(e));
    }
  }

  function updateDoc(i: number, patch: Partial<DocInput>) {
    resetOutputs();
    setDocs((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  function addDoc() {
    resetOutputs();
    setDocs((prev) => [...prev, { url: "", label: "", mime: "application/pdf" }]);
  }

  function removeDoc(i: number) {
    resetOutputs();
    setDocs((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onHashAndBuildManifest() {
    resetOutputs();

    if (!candidateId.trim()) {
      alert("Candidate ID is required (must match candidates.csv id).");
      return;
    }
    if (!issuerNorm) {
      alert("Issuer domain is required (e.g. https://candidate.fi).");
      return;
    }
    const isTest = new URLSearchParams(window.location.search).get("test") === "1";
    const isLocal = window.location.hostname === "localhost";
    
    if (domainStatus !== "verified" && !(isTest && isLocal)) {
      alert("Please verify domain proof first (so disclosures can’t be impersonated).");
      return;
    }


    const cleanDocs = docs
      .map((d) => ({
        url: d.url.trim(),
        label: d.label.trim() || "Document",
        mime: d.mime.trim(),
      }))
      .filter((d) => d.url);

    if (!cleanDocs.length) {
      alert("Add at least one document URL.");
      return;
    }

    setHashing(true);
    try {
      const results: Array<{ sha256: string; size: number; error?: string }> = [];

      for (const d of cleanDocs) {
        try {
          const { sha256, size } = await hashRemoteFile(d.url);
          results.push({ sha256, size });
        } catch (e: any) {
          results.push({ sha256: "", size: 0, error: e?.message || String(e) });
        }
      }

      setDocResults(results);

      // If any doc failed, stop before producing a manifest.
      const anyFailed = results.some((r) => r.error || !r.sha256);
      if (anyFailed) {
        alert(
          "Some documents could not be fetched/hashed. Fix the errors and try again.\n\n" +
            "Common fix: ensure the document URL is publicly accessible and served with CORS."
        );
        return;
      }

      const manifest: Manifest = {
        schema: "ehdokas.disclosure.v1",
        candidateId: candidateId.trim(),
        issuer: issuerNorm,
        createdAt: new Date().toISOString(),
        domainProof: {
          method: "well-known",
          url: proofUrl,
          token: domainToken,
          verifiedAt: domainVerifiedAt || undefined,
        },
        docs: cleanDocs.map((d, i) => ({
          url: d.url,
          sha256: results[i].sha256,
          label: d.label,
          mime: d.mime || undefined,
        })),
      };

      const text = canonicalStringify(manifest);
      const msha = await sha256Text(text);

      setManifestText(text);
      setManifestSha(msha);
    } finally {
      setHashing(false);
    }
  }

  function downloadManifest() {
    if (!manifestText) return;
    const blob = new Blob([manifestText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ehdokas-disclosure-${candidateId.trim() || "candidate"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Disclose documents</h1>
        <a href="#/" style={{ textDecoration: "underline" }}>← Back</a>
      </div>

      <p style={{ opacity: 0.85 }}>
        Ehdokas never stores your files. Documents stay on your own website. This tool computes SHA-256 hashes in your browser
        and generates a disclosure manifest you can publish to a transparency log (Rekor).
      </p>

      <hr />

      <h2>1) Candidate identity</h2>
      <div style={{ display: "grid", gap: 12 }}>
        <label>
          <div style={{ fontWeight: 600 }}>Candidate ID</div>
          <input
            value={candidateId}
            onChange={(e) => setCandidateId(e.target.value)}
            placeholder="must match candidates.csv id (e.g. pauli-aalto-setala)"
            style={{ width: "100%", padding: 10 }}
          />
        </label>

        <label>
          <div style={{ fontWeight: 600 }}>Your website (issuer domain)</div>
          <input
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
            placeholder="https://candidate.fi"
            style={{ width: "100%", padding: 10 }}
          />
          {issuerNorm && <div style={{ opacity: 0.8, marginTop: 6 }}>Normalized: {issuerNorm}</div>}
        </label>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button onClick={onGenerateToken} style={{ padding: "10px 12px" }}>
            Generate domain proof token
          </button>

          {domainToken && (
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
              Put this in <b>{proofUrl}</b> exactly:
              <div style={{ marginTop: 6, padding: 10, background: "#111", color: "#fff", borderRadius: 8 }}>
                ehdokas-domain-proof={domainToken}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            onClick={onVerifyDomain}
            disabled={!proofUrl || !domainToken || domainStatus === "verifying"}
            style={{ padding: "10px 12px" }}
          >
            {domainStatus === "verifying" ? "Verifying…" : "Verify domain proof"}
          </button>

          <div>
            Status:{" "}
            <b>
              {domainStatus === "idle"
                ? "Not started"
                : domainStatus === "generated"
                ? "Token generated"
                : domainStatus === "verifying"
                ? "Verifying"
                : domainStatus === "verified"
                ? "Verified"
                : "Failed"}
            </b>
            {domainVerifiedAt && <span style={{ opacity: 0.8 }}> · {domainVerifiedAt}</span>}
          </div>
        </div>

        {domainError && (
          <pre style={{ whiteSpace: "pre-wrap", background: "#fee", padding: 12, borderRadius: 8 }}>
            {domainError}
          </pre>
        )}
      </div>

      <hr />

      <h2>2) Documents</h2>
      <p style={{ opacity: 0.85 }}>
        Add public URLs to your disclosure documents. Your server must allow public GET access.
        If hashing fails due to CORS, adjust your hosting to allow browser access.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {docs.map((d, i) => (
          <div key={i} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <label style={{ flex: "1 1 520px" }}>
                <div style={{ fontWeight: 600 }}>Document URL</div>
                <input
                  value={d.url}
                  onChange={(e) => updateDoc(i, { url: e.target.value })}
                  placeholder="https://candidate.fi/disclosures/asset.pdf"
                  style={{ width: "100%", padding: 10 }}
                />
              </label>

              <label style={{ flex: "1 1 240px" }}>
                <div style={{ fontWeight: 600 }}>Label</div>
                <input
                  value={d.label}
                  onChange={(e) => updateDoc(i, { label: e.target.value })}
                  placeholder="Asset declaration"
                  style={{ width: "100%", padding: 10 }}
                />
              </label>

              <label style={{ flex: "1 1 220px" }}>
                <div style={{ fontWeight: 600 }}>MIME (optional)</div>
                <input
                  value={d.mime}
                  onChange={(e) => updateDoc(i, { mime: e.target.value })}
                  placeholder="application/pdf"
                  style={{ width: "100%", padding: 10 }}
                />
              </label>

              <div style={{ display: "flex", alignItems: "end" }}>
                <button onClick={() => removeDoc(i)} disabled={docs.length === 1} style={{ padding: "10px 12px" }}>
                  Remove
                </button>
              </div>
            </div>

            {docResults[i] && (
              <div style={{ marginTop: 10 }}>
                {docResults[i].error ? (
                  <div style={{ color: "#a00" }}>Error: {docResults[i].error}</div>
                ) : (
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
                    sha256: {docResults[i].sha256} · size: {docResults[i].size} bytes
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={addDoc} style={{ padding: "10px 12px" }}>+ Add document</button>

          <button
            onClick={onHashAndBuildManifest}
            disabled={hashing}
            style={{ padding: "10px 12px", fontWeight: 700 }}
          >
            {hashing ? "Hashing…" : "Hash documents + Build manifest"}
          </button>
        </div>
      </div>

      <hr />

      <h2>3) Manifest output</h2>

      {manifestSha ? (
        <>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              Manifest SHA-256:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {manifestSha}
              </span>
            </div>
            <button onClick={downloadManifest} style={{ padding: "10px 12px" }}>
              Download manifest.json
            </button>
          </div>

          <pre style={{ marginTop: 12, whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12, borderRadius: 8 }}>
            {manifestText}
          </pre>

          <p style={{ opacity: 0.85 }}>
            Next step (coming immediately after this): sign this manifest and upload to Rekor. The Rekor entry will make
            your disclosure immutable and publicly auditable.
          </p>
        </>
      ) : (
        <p style={{ opacity: 0.8 }}>No manifest yet. Verify domain proof, then hash documents.</p>
      )}
    </div>
  );
}
