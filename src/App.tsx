import React, { useEffect, useMemo, useState } from "react";

/**
 * ehdokas.site — Candidate Openness Tracker
 * Storage-free: no DB, no cookies, no localStorage/sessionStorage/IndexedDB.
 * Loads a public elections index + per-election feed JSON and computes scores in-memory.
 */

type Evidence = {
  url: string;
  disclosedOn: string; // YYYY-MM-DD
  note?: string;
};

type DisclosureKey =
  | "verovelkatodistus"
  | "luottotieto_ote"
  | "huumeseula_neg"
  | "rikosrekisteriote"
  | "ulosottorekisteriote"
  | "kaupparekisteriote";

type Candidate = {
  id: string;
  name: string;
  party?: string;
  photoUrl?: string;
  website?: string;
  disclosures?: Partial<Record<DisclosureKey, Evidence[]>>;
};

type Feed = {
  schemaVersion: 1;
  jurisdiction?: string;
  electionName?: string;
  electionDay: string; // YYYY-MM-DD
  lastUpdated: string; // ISO datetime
  candidates: Candidate[];
  items?: Partial<Record<DisclosureKey, { label: string; weight: number; description: string }>>;
};

type ElectionIndex = {
  schemaVersion: 1;
  jurisdiction: string;
  lastUpdated: string;
  elections: Array<{
    id: string;
    name: string;
    electionDay: string; // YYYY-MM-DD
    feedUrl: string;
    lastUpdated?: string;
  }>;
};

// Default disclosure framework (Finland-first)
const DEFAULT_ITEMS: Record<DisclosureKey, { label: string; weight: number; description: string }> = {
  verovelkatodistus: {
    label: "Verovelkatodistus (Vero)",
    weight: 9,
    description:
      "Todistus verojen maksutilanteesta / verovelasta. Päiväys ratkaisee (tilanne muuttuu ajan myötä).",
  },
  luottotieto_ote: {
    label: "Luottotieto-ote (maksuhäiriöt)",
    weight: 9,
    description: "Ote, joka näyttää maksuhäiriömerkinnät ja niiden voimassaoloajat (rekisteriote).",
  },
  huumeseula_neg: {
    label: "Negatiivinen huumeseula",
    weight: 6,
    description: "Todistus negatiivisesta huumausainetestistä (esim. työterveys).",
  },
  rikosrekisteriote: {
    label: "Rikosrekisteriote (ORK)",
    weight: 10,
    description: "Rikosrekisteriote / ote rikosrekisteristä (Oikeusrekisterikeskus).",
  },
  ulosottorekisteriote: {
    label: "Ulosottorekisteriote",
    weight: 8,
    description: "Todistus ulosottorekisteristä. Päiväys ratkaisee.",
  },
  kaupparekisteriote: {
    label: "Kaupparekisteriote (PRH / Virre)",
    weight: 7,
    description: "Kaupparekisteriote ja yrityssidonnaisuudet (hallitukset, roolit, vastuut).",
  },
};

// ---------- helpers ----------
function parseDate(d: string): Date | null {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t) : null;
}
function dayTime(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function useIsNarrow(breakpointPx = 860) {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < breakpointPx : false
  );

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpointPx);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpointPx]);

  return narrow;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}


function isOnOrBefore(dateISO: string, cutoffISO: string): boolean {
  const d = parseDate(dateISO);
  const c = parseDate(cutoffISO);
  if (!d || !c) return false;
  return dayTime(d) <= dayTime(c);
}
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "source";
  }
}
function pickNextElection(index: ElectionIndex) {
  const now = new Date();
  const today = dayTime(now);
  const upcoming = index.elections
    .map((e) => ({ e, t: parseDate(e.electionDay)?.getTime() ?? -1 }))
    .filter((x) => x.t >= 0 && x.t >= today)
    .sort((a, b) => a.t - b.t);
  return upcoming[0]?.e ?? null;
}
function latestEvidenceBefore(evs: Evidence[] | undefined, cutoffISO: string): Evidence | null {
  if (!evs || evs.length === 0) return null;
  const filtered = evs
    .filter((e) => isOnOrBefore(e.disclosedOn, cutoffISO))
    .map((e) => ({ e, t: parseDate(e.disclosedOn)?.getTime() ?? -1 }))
    .filter((x) => x.t >= 0)
    .sort((a, b) => b.t - a.t);
  return filtered[0]?.e ?? null;
}
function daysUntil(dateISO: string): number | null {
  const d = parseDate(dateISO);
  if (!d) return null;
  const now = new Date();
  const diff = dayTime(d) - dayTime(now);
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function computeScores(feed: Feed, items: typeof DEFAULT_ITEMS) {
  const cutoff = feed.electionDay;
  const maxPoints = (Object.keys(items) as DisclosureKey[]).reduce((sum, k) => sum + items[k].weight, 0);

  const scored = feed.candidates.map((c) => {
    let points = 0;
    const perItem: Record<DisclosureKey, { has: boolean; points: number; evidence: Evidence | null }> = {} as any;

    (Object.keys(items) as DisclosureKey[]).forEach((k) => {
      const evidence = latestEvidenceBefore(c.disclosures?.[k], cutoff);
      const has = !!evidence;
      const p = has ? items[k].weight : 0;
      points += p;
      perItem[k] = { has, points: p, evidence };
    });

    const pct = maxPoints === 0 ? 0 : Math.round((points / maxPoints) * 100);
    <DocStrip perItem={s.perItem} />
    return { candidate: c, points, pct, perItem, maxPoints };
  });

  scored.sort((a, b) => b.points - a.points);
  return { scored, maxPoints };
}

// ---------- ticker ----------
type TickerMsg = { kind: "ok" | "missing"; text: string; href?: string; t?: number };

function buildTicker(feed: Feed, items: typeof DEFAULT_ITEMS): TickerMsg[] {
  const cutoff = feed.electionDay;

  const events: TickerMsg[] = [];
  for (const c of feed.candidates) {
    const dmap = c.disclosures ?? {};
    (Object.keys(items) as DisclosureKey[]).forEach((k) => {
      const evs = dmap[k] ?? [];
      for (const ev of evs) {
        if (!isOnOrBefore(ev.disclosedOn, cutoff)) continue;
        const ts = parseDate(ev.disclosedOn)?.getTime();
        if (!ts) continue;
        events.push({
          kind: "ok",
          t: ts,
          text: `✅ ${c.name}${c.party ? ` (${c.party})` : ""} • ${items[k].label} • ${ev.disclosedOn}`,
          href: ev.url,
        });
      }
    });
  }
  events.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));

  const missing: TickerMsg[] = feed.candidates.map((c) => {
    const miss: string[] = [];
    (Object.keys(items) as DisclosureKey[]).forEach((k) => {
      const has = !!latestEvidenceBefore(c.disclosures?.[k], cutoff);
      if (!has) miss.push(items[k].label);
    });
    if (miss.length === 0) {
      return { kind: "ok", text: `🏁 ${c.name}${c.party ? ` (${c.party})` : ""} • kaikki dokumentit julkaistu` };
    }
    const shown = miss.slice(0, 3);
    const more = miss.length > 3 ? ` +${miss.length - 3}` : "";
    return { kind: "missing", text: `🔴 ${c.name}${c.party ? ` (${c.party})` : ""} • puuttuu: ${shown.join(", ")}${more}` };
  });

  return [...events.slice(0, 25), ...missing.slice(0, 25)];
}

function TickerBar({ items }: { items: TickerMsg[] }) {
  if (!items.length) return null;
  const loop = [...items, ...items];

  return (
    <div style={{ minHeight: "100vh", ... }}>
    <style>{`
      /* Responsive system */
      .container { max-width: 1100px; margin: 0 auto; padding: 22px 16px 48px; }
      .heroGrid { display: grid; grid-template-columns: 1fr; gap: 18px; }
      .topRow { display:flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .search { width: 100%; max-width: 520px; }

      .candidateRow {
        cursor: pointer;
        border-radius: 18px;
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
        padding: 14px;
        display: grid;
        grid-template-columns: 52px 1fr;
        gap: 12px;
        align-items: start;
        text-align: left;
      }
      .candidateRight { grid-column: 1 / -1; }

      @media (min-width: 900px) {
        .heroGrid { grid-template-columns: 1.2fr 0.8fr; }
        .search { width: 280px; }
        .candidateRow { grid-template-columns: 52px 1fr 180px; align-items: center; }
        .candidateRight { grid-column: auto; }
      }

      @media (max-width: 520px) {
        .container { padding: 14px 12px 36px; }
        h1 { font-size: 26px !important; }
      }
    `}</style>
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.08)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        background: "rgba(255,255,255,0.03)",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes ehdokas-marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .ehdokas-marquee { animation: ehdokas-marquee 34s linear infinite; will-change: transform; }
        .ehdokas-marquee:hover { animation-play-state: paused; }
        @media (prefers-reduced-motion: reduce) { .ehdokas-marquee { animation: none !important; transform: none !important; } }
      `}</style>

      <div className="ehdokas-marquee" style={{ display: "inline-flex", whiteSpace: "nowrap", padding: "10px 0" }}>
        {loop.map((m, i) => (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0 14px",
              borderRight: "1px solid rgba(255,255,255,0.08)",
              fontSize: 13,
              color: m.kind === "missing" ? "rgba(255,140,140,0.95)" : "rgba(255,255,255,0.85)",
            }}
          >
            {m.href ? (
              <a
                href={m.href}
                target="_blank"
                rel="noreferrer"
                style={{ color: "inherit", textDecoration: "none", borderBottom: "1px solid rgba(255,255,255,0.25)" }}
              >
                {m.text}
              </a>
            ) : (
              m.text
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------- UI components ----------
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.10)",
        background: "rgba(255,255,255,0.06)",
        fontSize: 12,
        color: "rgba(255,255,255,0.85)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div style={{ height: 10, width: "100%", borderRadius: 999, background: "rgba(255,255,255,0.10)", overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, value))}%`,
          borderRadius: 999,
          background: "linear-gradient(90deg, rgba(255,255,255,0.9), rgba(255,255,255,0.55))",
        }}
      />
    </div>
  );
}

function DocStrip({
  perItem,
  items,
}: {
  perItem: Record<DisclosureKey, { has: boolean }>;
  items: typeof DEFAULT_ITEMS;
}) {
  const keys = Object.keys(items) as DisclosureKey[];
  const short: Record<DisclosureKey, string> = {
    verovelkatodistus: "VERO",
    luottotieto_ote: "LUOTTO",
    huumeseula_neg: "HUUME",
    rikosrekisteriote: "RIKOS",
    ulosottorekisteriote: "ULOS",
    kaupparekisteriote: "PRH",
  };

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {keys.map((k) => {
        const ok = perItem[k]?.has;
        return (
          <span
            key={k}
            title={`${items[k].label}: ${ok ? "julkaistu" : "puuttuu"}`}
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 0.2,
              padding: "4px 8px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.10)",
              background: ok ? "rgba(120,255,180,0.12)" : "rgba(255,120,120,0.10)",
              color: ok ? "rgba(160,255,210,0.95)" : "rgba(255,170,170,0.95)",
            }}
          >
            {short[k]}
          </span>
        );
      })}
    </div>
  );
}


function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 100%)",
          maxHeight: "85vh",
          overflow: "auto",
          borderRadius: 18,
          background: "rgba(18,18,20,0.98)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
        }}
      >
        <div style={{ padding: 18, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div style={{ fontWeight: 700 }}>{title}</div>
            <button
              onClick={onClose}
              style={{
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "white",
                borderRadius: 12,
                padding: "6px 10px",
                cursor: "pointer",
              }}
            >
              Sulje
            </button>
          </div>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
      </div>
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const isNarrow = useIsNarrow(860);
  const [index, setIndex] = useState<ElectionIndex | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [selectedElectionId, setSelectedElectionId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [howOpen, setHowOpen] = useState(false);

  // ticker
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [tickerFilter, setTickerFilter] = useState<"all" | "ok" | "missing">("all");
  const [tickerMsgs, setTickerMsgs] = useState<TickerMsg[]>([]);

  const items = useMemo(() => {
    if (!feed?.items) return DEFAULT_ITEMS;
    const merged: any = { ...DEFAULT_ITEMS };
    (Object.keys(feed.items) as DisclosureKey[]).forEach((k) => {
      merged[k] = { ...merged[k], ...(feed.items?.[k] ?? {}) };
    });
    return merged as typeof DEFAULT_ITEMS;
  }, [feed]);

  async function loadIndex() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/elections/index.json", { cache: "no-store", credentials: "omit" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const data = (await r.json()) as ElectionIndex;
      if (!data || data.schemaVersion !== 1) throw new Error("Invalid index.json schemaVersion");
      setIndex(data);

      const next = pickNextElection(data);
      if (next) {
        setSelectedElectionId(next.id);
        await loadFeed(next.feedUrl);
      } else {
        setErr("Index loaded, but no upcoming elections were found.");
      }
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load elections index");
    } finally {
      setLoading(false);
    }
  }

  async function loadFeed(feedUrl: string) {
    setLoading(true);
    setErr(null);
    setFeed(null);
    try {
      const r = await fetch(feedUrl, {
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!r.ok) throw new Error(`Feed fetch failed: ${r.status} ${r.statusText}`);
      const data = (await r.json()) as Feed;
      if (!data || data.schemaVersion !== 1) throw new Error("Invalid feed schemaVersion");
      if (!data.electionDay) throw new Error("feed.json missing electionDay");
      if (!Array.isArray(data.candidates)) throw new Error("feed.json missing candidates[]");
      setFeed(data);
      setLastRefresh(new Date().toISOString());
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load feed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadIndex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // recompute ticker when feed/items changes
  useEffect(() => {
    if (!feed) return;
    setTickerMsgs(buildTicker(feed, items));
  }, [feed, items]);

  // auto-refresh current election feed every 60s
  useEffect(() => {
    if (!index || !selectedElectionId) return;
    const chosen = index.elections.find((e) => e.id === selectedElectionId);
    if (!chosen) return;

    const timer = window.setInterval(() => {
      loadFeed(chosen.feedUrl);
      setLastRefresh(new Date().toISOString());
    }, 60_000);

    return () => window.clearInterval(timer);
  }, [index, selectedElectionId]);

  const shownTicker = useMemo(() => {
    if (tickerFilter === "all") return tickerMsgs;
    return tickerMsgs.filter((m) => m.kind === tickerFilter);
  }, [tickerMsgs, tickerFilter]);

  const computed = useMemo(() => (feed ? computeScores(feed, items) : null), [feed, items]);

  const filtered = useMemo(() => {
    if (!computed) return [];
    const q = query.trim().toLowerCase();
    if (!q) return computed.scored;
    return computed.scored.filter(({ candidate }) => {
      const hay = `${candidate.name} ${candidate.party ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [computed, query]);

  const selected = useMemo(() => {
    if (!computed || !selectedCandidateId) return null;
    return computed.scored.find((s) => s.candidate.id === selectedCandidateId) ?? null;
  }, [computed, selectedCandidateId]);

  const dLeft = feed?.electionDay ? daysUntil(feed.electionDay) : null;

  const filterBtn = (active: boolean): React.CSSProperties => ({
    cursor: "pointer",
    borderRadius: 14,
    padding: "8px 10px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
    color: "white",
    fontSize: 13,
    fontWeight: 700,
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        color: "white",
        background:
          "radial-gradient(1200px 600px at 10% 10%, rgba(255,255,255,0.10), transparent 60%), radial-gradient(1000px 500px at 90% 20%, rgba(255,255,255,0.08), transparent 55%), linear-gradient(180deg, #070708, #0b0b0d 60%, #070708)",
      }}
    >
      {/* top bar */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          backdropFilter: "blur(10px)",
          background: "rgba(8,8,10,0.72)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 14,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.10)",
                display: "grid",
                placeItems: "center",
                fontWeight: 800,
              }}
              title="ehdokas.site"
            >
              e
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>ehdokas.site</div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)" }}>
                Ehdokkaiden avoimuus – vain julkiset todisteet, ei tallennusta
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Chip>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background: "rgba(120,255,180,0.9)",
                    boxShadow: "0 0 16px rgba(120,255,180,0.55)",
                  }}
                />
                LIVE
              </span>
              {lastRefresh ? (
                <span style={{ color: "rgba(255,255,255,0.7)" }}>
                  • {new Date(lastRefresh).toLocaleTimeString("fi-FI")}
                </span>
              ) : null}
            </Chip>

            <button
              onClick={() => setHowOpen(true)}
              style={{
                cursor: "pointer",
                borderRadius: 14,
                padding: "9px 12px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.06)",
                color: "white",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Miten tämä toimii
            </button>
          </div>
        </div>
      </div>

      {/* Sortino-style ticker */}
      {shownTicker.length > 0 && <TickerBar items={shownTicker} />}

      <main className="container">
        {/* hero */}
            <div className="heroGrid">


            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Chip>✅ vain julkiset linkit</Chip>
              <Chip>🧠 pisteytys selaimessa</Chip>
              <Chip>🗄️ ei tallennusta</Chip>
              <Chip>📅 cutoff = vaalipäivä</Chip>
            </div>

            <h1 style={{ margin: "14px 0 6px", fontSize: 34, lineHeight: 1.1 }}>
              Kuka on avoin – ennen vaalipäivää?
            </h1>
            <p style={{ margin: 0, color: "rgba(255,255,255,0.78)", fontSize: 14, maxWidth: 760 }}>
              ehdokas.site listaa, mitä keskeisiä avoimuusdokumentteja ehdokkaat ovat julkaisseet
              (verifioitavina linkkeinä) <b>ennen vaalipäivää</b>. Sivusto ei tallenna mitään materiaalia.
            </p>

            <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={loadIndex}
                disabled={loading}
                style={{
                  cursor: loading ? "not-allowed" : "pointer",
                  borderRadius: 16,
                  padding: "10px 12px",
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.10)",
                  color: "white",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {loading ? "Ladataan…" : "Päivitä tiedot"}
              </button>

              {/* ticker filters */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setTickerFilter("all")} style={filterBtn(tickerFilter === "all")}>
                  Kaikki
                </button>
                <button onClick={() => setTickerFilter("ok")} style={filterBtn(tickerFilter === "ok")}>
                  ✅ Uudet
                </button>
                <button onClick={() => setTickerFilter("missing")} style={filterBtn(tickerFilter === "missing")}>
                  🔴 Puuttuvat
                </button>
              </div>

              {feed?.electionDay && (
                <Chip>
                  Vaalipäivä: <b style={{ color: "white" }}>{feed.electionDay}</b>
                  {typeof dLeft === "number" && (
                    <span style={{ color: "rgba(255,255,255,0.7)" }}>
                      {" "}
                      • {dLeft >= 0 ? `${dLeft} pv` : `${Math.abs(dLeft)} pv sitten`}
                    </span>
                  )}
                </Chip>
              )}
            </div>

            {err && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 16,
                  border: "1px solid rgba(255,120,120,0.25)",
                  background: "rgba(255,120,120,0.08)",
                  color: "rgba(255,255,255,0.9)",
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                }}
              >
                {err}
              </div>
            )}
          </div>

          <div
            style={{
              borderRadius: 22,
              border: "1px solid rgba(255,255,255,0.10)",
              background: "rgba(255,255,255,0.04)",
              padding: 18,
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Valitse vaali</div>

            {index ? (
              <>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)", marginBottom: 10 }}>
                  {index.jurisdiction} • index päivitetty {index.lastUpdated}
                </div>

                <select
                  value={selectedElectionId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedElectionId(id);
                    const chosen = index.elections.find((x) => x.id === id);
                    if (chosen) loadFeed(chosen.feedUrl);
                  }}
                  style={{
                    width: "100%",
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    padding: "10px 12px",
                    fontSize: 13,
                    outline: "none",
                  }}
                >
                  {index.elections
                    .slice()
                    .sort((a, b) => (parseDate(a.electionDay)?.getTime() ?? 0) - (parseDate(b.electionDay)?.getTime() ?? 0))
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.electionDay} — {e.name}
                      </option>
                    ))}
                </select>

                <div style={{ marginTop: 14, fontSize: 12, color: "rgba(255,255,255,0.70)" }}>
                  <b style={{ color: "white" }}>Ei tallennusta:</b> data ladataan vain julkisista JSON-tiedostoista ja
                  pisteytetään selaimessa.
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.75)" }}>Ladataan vaali-indeksi…</div>
            )}
          </div>
        </div>

        {/* leaderboard */}
        <div style={{ marginTop: 18 }}>
          <input className="search" ... />
          <div className="topRow">
            <div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)" }}>Ranking</div>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{feed?.electionName ? feed.electionName : "Seuraavat vaalit"}</div>
              {feed?.lastUpdated && (
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)" }}>
                  Feed päivitetty: <span style={{ color: "rgba(255,255,255,0.9)" }}>{feed.lastUpdated}</span>
                </div>
              )}
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Hae ehdokas / puolue…"
              style={{
                width: isNarrow ? "100%" : 280,
                maxWidth: "100%",
                borderRadius: 16,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(0,0,0,0.25)",
                color: "white",
                padding: "10px 12px",
                fontSize: 13,
                outline: "none",
              }}
            />
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            {!computed && <div style={{ color: "rgba(255,255,255,0.70)", fontSize: 13 }}>Lataa vaali nähdäksesi rankingin.</div>}
            {computed && filtered.length === 0 && <div style={{ color: "rgba(255,255,255,0.70)", fontSize: 13 }}>Ei hakutuloksia.</div>}

            {computed &&
              filtered.map((s, idx) => (
                <button
                  key={s.candidate.id}
                  onClick={() => setSelectedCandidateId(s.candidate.id)}
                  <button
                    key={s.candidate.id}
                    onClick={() => setSelectedCandidateId(s.candidate.id)}
                    className="candidateRow"
                  >

                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 16,
                      background: "rgba(255,255,255,0.08)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      display: "grid",
                      placeItems: "center",
                      overflow: "hidden",
                      fontWeight: 900,
                    }}
                    title={`Sija ${idx + 1}`}
                  >
                    {s.candidate.photoUrl ? (
                      <img src={s.candidate.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ fontWeight: 900, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {s.candidate.name}
                      </div>
                      {s.candidate.party && <Chip>{s.candidate.party}</Chip>}
                    </div>
                    <div style={{ marginTop: 8 }}>
                        <DocStrip perItem={s.perItem} items={items} />
                      </div>
                    <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.70)" }}>
                      {s.points} / {s.maxPoints} pistettä • {s.pct}% avoimuus
                    </div>
                  </div>

                  <div>
                    style={isNarrow ? { gridColumn: "1 / -1" } : undefined}
                    <ProgressBar value={s.pct} />
                    <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Chip>Katso tiedot →</Chip>
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>

        {/* footer */}
        <div
          style={{
            marginTop: 26,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            paddingTop: 14,
            color: "rgba(255,255,255,0.70)",
            fontSize: 12,
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <b style={{ color: "white" }}>Storage-free:</b> pisteytys tapahtuu selaimessa. Linkit vievät ulkoisiin lähteisiin.
          </div>
          <div>Vihje ehdokkaille: julkaise dokumentit (mieluiten redaktioituna) ja lisää pysyvä linkki.</div>
        </div>
      </main>

      {/* Candidate modal */}
      <Modal
        open={!!selected}
        onClose={() => setSelectedCandidateId(null)}
        title={selected ? `${selected.candidate.name}${selected.candidate.party ? ` — ${selected.candidate.party}` : ""}` : ""}
      >
        {selected && (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
              <Chip>
                Avoimuus: <b style={{ color: "white" }}>{selected.pct}%</b>
              </Chip>
              <Chip>
                Pisteet:{" "}
                <b style={{ color: "white" }}>
                  {selected.points}/{selected.maxPoints}
                </b>
              </Chip>
              {feed?.electionDay && (
                <Chip>
                  Cutoff (vaalipäivä): <b style={{ color: "white" }}>{feed.electionDay}</b>
                </Chip>
              )}
              {selected.candidate.website && (
                <a href={selected.candidate.website} target="_blank" rel="noreferrer" style={{ color: "white", textDecoration: "none" }}>
                  <Chip>🌐 kotisivu</Chip>
                </a>
              )}
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              {(Object.keys(items) as DisclosureKey[]).map((k) => {
                const row = selected.perItem[k];
                return (
                  <div
                    key={k}
                    style={{
                      borderRadius: 16,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.04)",
                      padding: 14,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 900 }}>{items[k].label}</div>
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.70)", marginTop: 3 }}>
                          {items[k].description}
                        </div>
                      </div>
                      <Chip>{row.has ? `✅ +${row.points}` : "❌ +0"}</Chip>
                    </div>

                    {row.has && row.evidence ? (
                      <div style={{ marginTop: 10, fontSize: 13 }}>
                        <a
                          href={row.evidence.url}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "white", textDecoration: "underline", textUnderlineOffset: 4 }}
                        >
                          Todiste ({safeHost(row.evidence.url)})
                        </a>
                        <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.70)" }}>
                          Julkaistu: <b style={{ color: "white" }}>{row.evidence.disclosedOn}</b>
                        </div>
                        {row.evidence.note && (
                          <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.70)" }}>{row.evidence.note}</div>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginTop: 10, fontSize: 12, color: "rgba(255,255,255,0.70)" }}>
                        Ei qualifying-julkaisua ennen vaalipäivää.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Modal>

      {/* How it works modal */}
      <Modal open={howOpen} onClose={() => setHowOpen(false)} title="Miten ehdokas.site toimii?">
        <div style={{ display: "grid", gap: 12, color: "rgba(255,255,255,0.85)", fontSize: 13 }}>
          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", padding: 14 }}>
            <b style={{ color: "white" }}>1) Julkinen vaali-indeksi</b>
            <div style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
              Sivusto lukee tiedoston <code>/elections/index.json</code>, joka listaa tulevat vaalit ja niiden feed-URL:t.
            </div>
          </div>

          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", padding: 14 }}>
            <b style={{ color: "white" }}>2) Per-vaali feed.json</b>
            <div style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
              Jokaisella vaalilla on oma <code>feed.json</code>, jossa on ehdokkaat ja todiste-linkit (URL + disclosedOn). Pisteet lasketaan selaimessa.
            </div>
          </div>

          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", padding: 14 }}>
            <b style={{ color: "white" }}>3) Cutoff = vaalipäivä</b>
            <div style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
              Dokumentti lasketaan mukaan vain, jos sen <code>disclosedOn</code> on <b>vaalipäivänä tai ennen</b>.
            </div>
          </div>

          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", padding: 14 }}>
            <b style={{ color: "white" }}>Ei tallennusta</b>
            <div style={{ marginTop: 6, color: "rgba(255,255,255,0.75)" }}>
              Ehdokas.site ei tallenna materiaalia. Se näyttää vain julkiset linkit ja laskee pisteet muistissa. Huom: linkin kohdesivusto voi lokittaa käynnin.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}

