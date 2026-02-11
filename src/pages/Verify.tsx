import React from "react";
import { sha256Text, sha256Bytes } from "../lib/crypto";

type RekorEntry = {
  logIndex?: number;
  integratedTime?: number;
  body?: string; // base64
};

type RekorBody = {
  spec?: {
    data?: { hash?: { algorithm?: string; value?: string } };
    signature?: {
      format?: string;
      content?: string;
      publicKey?: { content?: string };
    };
  };
};

function getQueryParam(name: string): string | null {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array([...bin].map((c) => c.charCodeAt(0)));
  return new TextDecoder().decode(bytes);
}

async function fetchJson(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.json();
}

async function fetchText(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  return res.text();
}

async function hashRemote(url: string): Promise<{ sha256: string; size: number }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  return { sha256: await sha256Bytes(bytes), size: bytes.byteLength };
}

export default function Verify() {
  const [rekorId, setRekorId] = React.useState(getQueryParam("rekor") || "");
  const [manifestUrl, setManifestUrl] = React.useState(
    getQueryParam("manifest") || "https://ehdokas.site/test-manifests/test.json"
  );

  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const [rekorMeta, setRekorMeta] = React.useState<{
    logIndex?: number;
    integratedTime?: number;
    artifactHash?: string;
  }>({});

  const [manifestText, setManifestText] = React.useState<string>("");
  const [manifestHash, setManifestHash] = React.useState<string>("");

  const [docChecks, setDocChecks] = React.useState<
    Array<{ url: string; expected: string; got?: string; size?: number; ok?: boolean; error?: string }>
  >([]);

  async function runVerify() {
    setErr(null);
    setLoading(true);
    setRekorMeta({});
    setManifestText("");
    setManifestHash("");
    setDocChecks([]);

    try {
      if (!rekorId.trim()) throw new Error("Missing Rekor UUID (rekor=...)");
      if (!manifestUrl.trim()) throw new Error("Missing manifest URL");

      // 1) Fetch Rekor entry
      const rekorUrl = `https://rekor.sigstore.dev/api/v1/log/entries/${encodeURIComponent(rekorId.trim())}`;
      const rekorResp = await fetchJson(rekorUrl);

      const firstKey = Object.keys(rekorResp)[0];
      if (!firstKey) throw new Error("Rekor response had no entries (invalid UUID?)");

      const entry: RekorEntry = rekorResp[firstKey];
      if (!entry?.body) throw new Error("Rekor entry missing body");

      const bodyJson = JSON.parse(b64ToUtf8(entry.body)) as RekorBody;
      const artifactHash = bodyJson?.spec?.data?.hash?.value || "";

      setRekorMeta({
        logIndex: entry.logIndex,
        integratedTime: entry.integratedTime,
        artifactHash,
      });

      if (!artifactHash) throw new Error("Could not read artifact hash from Rekor entry body");

      // 2) Fetch manifest and verify its hash equals the Rekor-logged artifact hash
      const mText = await fetchText(manifestUrl.trim());
      const mHash = await sha256Text(mText);

      setManifestText(mText);
      setManifestHash(mHash);

      if (mHash !== artifactHash) {
        throw new Error(
          `Manifest hash mismatch.\n\nRekor logged: ${artifactHash}\nManifest sha256: ${mHash}\n\nThis means the manifest at the URL is not the same artifact that was logged in Rekor.`
        );
      }

      // 3) Parse manifest JSON
      const manifest = JSON.parse(mText);
      const docs: Array<{ url: string; sha256: string }> = Array.isArray(manifest?.docs) ? manifest.docs : [];
      if (!docs.length) throw new Error("Manifest has no docs[] to verify.");

      // 4) Re-hash each disclosed doc URL (live) and compare
      const checks: Array<{ url: string; expected: string; got?: string; size?: number; ok?: boolean; error?: string }> =
        [];

      for (const d of docs) {
        const url = String(d?.url || "");
        const expected = String(d?.sha256 || "");
        if (!url || !expected) {
          checks.push({ url, expected, ok: false, error: "Missing url or sha256 in manifest doc entry" });
          continue;
        }
        try {
          const { sha256, size } = await hashRemote(url);
          checks.push({ url, expected, got: sha256, size, ok: sha256 === expected });
        } catch (e: any) {
          checks.push({ url, expected, ok: false, error: e?.message || String(e) });
        }
      }

      setDocChecks(checks);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    // auto-run if rekor is present in URL
    if (rekorId.trim()) runVerify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const manifestOk =
    rekorMeta.artifactHash && manifestHash && rekorMeta.artifactHash === manifestHash;

  const docsOk =
    docChecks.length > 0 && docChecks.every((c) => c.ok === true);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Verify disclosure</h1>
        <a href="/" style={{ textDecoration: "underline" }}>← Back</a>
      </div>

      <p style={{ opacity: 0.85 }}>
        This page verifies that a disclosure manifest is immutably logged in Rekor and that the linked documents still match
        the disclosed SHA-256 hashes. No files are stored here.
      </p>

      <hr />

      <div style={{ display: "grid", gap: 12 }}>
        <label>
          <div style={{ fontWeight: 600 }}>Rekor UUID</div>
          <input
            value={rekorId}
            onChange={(e) => setRekorId(e.target.value)}
            placeholder="108e9186e8c5677a..."
            style={{ width: "100%", padding: 10 }}
          />
        </label>

        <label>
          <div style={{ fontWeight: 600 }}>Manifest URL</div>
          <input
            value={manifestUrl}
            onChange={(e) => setManifestUrl(e.target.value)}
            placeholder="https://candidate.fi/.well-known/ehdokas/manifest.json"
            style={{ width: "100%", padding: 10 }}
          />
        </label>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={runVerify} disabled={loading} style={{ padding: "10px 12px", fontWeight: 700 }}>
            {loading ? "Verifying…" : "Verify"}
          </button>

          {rekorId && manifestUrl && (
            <a
              href={`/verify?rekor=${encodeURIComponent(rekorId)}&manifest=${encodeURIComponent(manifestUrl)}`}
              style={{ alignSelf: "center", textDecoration: "underline" }}
            >
              Permalink
            </a>
          )}
        </div>
      </div>

      {err && (
        <pre style={{ whiteSpace: "pre-wrap", background: "#fee", padding: 12, borderRadius: 8, marginTop: 12 }}>
          {err}
        </pre>
      )}

      {!!rekorMeta.artifactHash && (
        <>
          <hr />
          <h2>Rekor</h2>
          <div style={{ display: "grid", gap: 8 }}>
            <div>
              Entry:{" "}
              <a
                href={`https://rekor.sigstore.dev/api/v1/log/entries/${encodeURIComponent(rekorId)}`}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "underline" }}
              >
                {rekorId}
              </a>
            </div>
            <div>Log index: <b>{rekorMeta.logIndex ?? "—"}</b></div>
            <div>
              Integrated time:{" "}
              <b>
                {rekorMeta.integratedTime
                  ? new Date(rekorMeta.integratedTime * 1000).toISOString()
                  : "—"}
              </b>
            </div>
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
              Rekor artifact sha256: {rekorMeta.artifactHash}
            </div>
          </div>

          <hr />
          <h2>Manifest</h2>
          <div style={{ display: "grid", gap: 8 }}>
            <div>URL: <a href={manifestUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{manifestUrl}</a></div>
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 }}>
              Manifest sha256: {manifestHash || "—"}
            </div>
            <div>
              Status:{" "}
              <b style={{ color: manifestOk ? "green" : "crimson" }}>
                {manifestOk ? "MATCHES Rekor" : "MISMATCH"}
              </b>
            </div>
          </div>

          {manifestText && (
            <details style={{ marginTop: 10 }}>
              <summary>Show manifest JSON</summary>
              <pre style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: 12, borderRadius: 8 }}>
                {manifestText}
              </pre>
            </details>
          )}

          <hr />
          <h2>Documents</h2>
          <div style={{ marginBottom: 10 }}>
            Overall:{" "}
            <b style={{ color: docsOk ? "green" : "crimson" }}>
              {docChecks.length ? (docsOk ? "ALL MATCH" : "SOME FAILED") : "—"}
            </b>
          </div>

          <div style={{ display: "grid", gap: 10 }}>
            {docChecks.map((c, idx) => (
              <div key={idx} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
                <div>
                  <a href={c.url} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                    {c.url}
                  </a>
                </div>
                {c.error ? (
                  <div style={{ color: "crimson", marginTop: 6 }}>Error: {c.error}</div>
                ) : (
                  <>
                    <div style={{ marginTop: 6 }}>
                      Status:{" "}
                      <b style={{ color: c.ok ? "green" : "crimson" }}>{c.ok ? "MATCH" : "MISMATCH"}</b>
                      {typeof c.size === "number" ? <span style={{ opacity: 0.8 }}> · {c.size} bytes</span> : null}
                    </div>
                    <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, marginTop: 6 }}>
                      expected: {c.expected}
                      <br />
                      got: {c.got}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

