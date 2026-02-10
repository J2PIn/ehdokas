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

  return [...events.slice(0, 30), ...missing.slice(0, 30)];
}

// ---------- UI bits ----------
function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2.5 w-full rounded-full bg-slate-900/10 overflow-hidden">
      <div className="h-full rounded-full bg-slate-900/70" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
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
      className="fixed inset-0 z-50 bg-black/60 p-4 flex items-center justify-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[85vh] overflow-auto rounded-2xl border border-white/10 bg-white/90 backdrop-blur shadow-2xl"
      >
        <div className="p-4 border-b border-slate-900/10 flex items-center justify-between gap-3">
          <div className="font-semibold text-slate-900">{title}</div>
          <button
            onClick={onClose}
            className="rounded-xl px-3 py-2 text-sm font-semibold border border-slate-900/10 bg-white hover:bg-slate-50"
          >
            Sulje
          </button>
        </div>
        <div className="p-4 text-slate-900">{children}</div>
      </div>
    </div>
  );
}

function TickerBar({ items }: { items: TickerMsg[] }) {
  if (!items.length) return null;
  const loop = [...items, ...items];

  return (
    <div className="border-y border-slate-900/10 bg-white/60 backdrop-blur overflow-hidden">
      <div className="marquee inline-flex whitespace-nowrap py-2">
        {loop.map((m, i) => (
          <span key={i} className="inline-flex items-center gap-3 px-4 border-r border-slate-900/10 text-sm">
            {m.href ? (
              <a
                href={m.href}
                target="_blank"
                rel="noreferrer"
                className={
                  m.kind === "missing"
                    ? "text-rose-600 hover:underline underline-offset-4"
                    : "text-slate-700 hover:underline underline-offset-4"
                }
              >
                {m.text}
              </a>
            ) : (
              <span className={m.kind === "missing" ? "text-rose-600" : "text-slate-700"}>{m.text}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function DocStrip({
  perItem,
}: {
  perItem: Record<DisclosureKey, { has: boolean; points: number; evidence: Evidence | null }>;
}) {
  const order: Array<[DisclosureKey, string]> = [
    ["verovelkatodistus", "VERO"],
    ["luottotieto_ote", "LUOTTO"],
    ["huumeseula_neg", "HUUME"],
    ["rikosrekisteriote", "RIKOS"],
    ["ulosottorekisteriote", "ULOS"],
    ["kaupparekisteriote", "PRH"],
  ];

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {order.map(([k, label]) => {
        const ok = perItem[k]?.has;
        return (
          <span
            key={k}
            className={
              ok
                ? "text-[11px] font-bold rounded-full px-2 py-1 border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "text-[11px] font-bold rounded-full px-2 py-1 border border-rose-200 bg-rose-50 text-rose-700"
            }
            title={`${label}: ${ok ? "julkaistu" : "puuttuu"}`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

// ---------- App ----------
export default function App() {
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

  return (
    <div className="min-h-screen">
      {/* Top bar (Sortino feel) */}
      <div className="sticky top-0 z-20 border-b border-slate-900/10 bg-white/70 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-2xl bg-slate-900/5 border border-slate-900/10 grid place-items-center font-black text-slate-900">
              e
            </div>
            <div className="min-w-0">
              <div className="font-extrabold text-slate-900">ehdokas.site</div>
              <div className="text-xs text-slate-600 truncate">
                Ehdokkaiden avoimuus – vain julkiset todisteet, ei tallennusta
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className="inline-flex items-center gap-2 rounded-full border border-slate-900/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_16px_rgba(16,185,129,0.55)]" />
              LIVE
              {lastRefresh ? (
                <span className="text-slate-500">• {new Date(lastRefresh).toLocaleTimeString("fi-FI")}</span>
              ) : null}
            </span>

            <button
              onClick={() => setHowOpen(true)}
              className="rounded-xl px-3 py-2 text-sm font-semibold border border-slate-900/10 bg-white hover:bg-slate-50"
            >
              Miten tämä toimii
            </button>
          </div>
        </div>
      </div>

      {/* Ticker (Sortino marquee) */}
      {shownTicker.length > 0 && <TickerBar items={shownTicker} />}

      <main className="mx-auto max-w-5xl px-4 py-6 pb-12">
        {/* Hero + chooser grid (mobile-first) */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_.8fr] gap-4 lg:gap-5">
          <div className="rounded-3xl border border-slate-900/10 bg-white/70 backdrop-blur shadow-soft p-4 lg:p-5">
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-slate-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                ✅ vain julkiset linkit
              </span>
              <span className="rounded-full border border-slate-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                🧠 pisteytys selaimessa
              </span>
              <span className="rounded-full border border-slate-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                🗄️ ei tallennusta
              </span>
              <span className="rounded-full border border-slate-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
                📅 cutoff = vaalipäivä
              </span>
            </div>

            <h1 className="mt-4 text-3xl lg:text-4xl font-extrabold tracking-tight text-slate-900">
              Kuka on avoin – ennen vaalipäivää?
            </h1>
            <p className="mt-2 text-sm text-slate-700 max-w-2xl">
              ehdokas.site listaa, mitä keskeisiä avoimuusdokumentteja ehdokkaat ovat julkaisseet{" "}
              <b>ennen vaalipäivää</b>. Sivusto ei tallenna mitään materiaalia.
            </p>

            <div className="mt-4 flex flex-wrap gap-2 items-center">
              <button
                onClick={loadIndex}
                disabled={loading}
                className="rounded-2xl px-4 py-2 text-sm font-bold border border-slate-900/10 bg-white hover:bg-slate-50 disabled:opacity-60"
              >
                {loading ? "Ladataan…" : "Päivitä tiedot"}
              </button>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setTickerFilter("all")}
                  className={
                    "rounded-2xl px-3 py-2 text-sm font-bold border border-slate-900/10 " +
                    (tickerFilter === "all" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50 text-slate-800")
                  }
                >
                  Kaikki
                </button>
                <button
                  onClick={() => setTickerFilter("ok")}
                  className={
                    "rounded-2xl px-3 py-2 text-sm font-bold border border-slate-900/10 " +
                    (tickerFilter === "ok" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50 text-slate-800")
                  }
                >
                  ✅ Uudet
                </button>
                <button
                  onClick={() => setTickerFilter("missing")}
                  className={
                    "rounded-2xl px-3 py-2 text-sm font-bold border border-slate-900/10 " +
                    (tickerFilter === "missing" ? "bg-slate-900 text-white" : "bg-white hover:bg-slate-50 text-slate-800")
                  }
                >
                  🔴 Puuttuvat
                </button>
              </div>

              {feed?.electionDay && (
                <span className="rounded-full border border-slate-900/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                  Vaalipäivä: <b className="text-slate-900">{feed.electionDay}</b>
                  {typeof dLeft === "number" ? (
                    <span className="text-slate-500"> • {dLeft >= 0 ? `${dLeft} pv` : `${Math.abs(dLeft)} pv sitten`}</span>
                  ) : null}
                </span>
              )}
            </div>

            {err && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 whitespace-pre-wrap">
                {err}
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-900/10 bg-white/60 backdrop-blur p-4 lg:p-5">
            <div className="font-extrabold text-slate-900">Valitse vaali</div>
            {index ? (
              <>
                <div className="mt-1 text-xs text-slate-600">
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
                  className="mt-3 w-full rounded-2xl border border-slate-900/10 bg-white px-3 py-3 text-sm text-slate-900"
                >
                  {index.elections
                    .slice()
                    .sort(
                      (a, b) =>
                        (parseDate(a.electionDay)?.getTime() ?? 0) - (parseDate(b.electionDay)?.getTime() ?? 0)
                    )
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.electionDay} — {e.name}
                      </option>
                    ))}
                </select>

                <div className="mt-4 text-xs text-slate-600">
                  <b className="text-slate-900">Ei tallennusta:</b> data ladataan vain julkisista JSON-tiedostoista ja
                  pisteytetään selaimessa.
                </div>
              </>
            ) : (
              <div className="mt-2 text-sm text-slate-600">Ladataan vaali-indeksi…</div>
            )}
          </div>
        </div>

        {/* Ranking */}
        <div className="mt-6">
          <div className="flex flex-wrap justify-between gap-3 items-end">
            <div>
              <div className="text-xs text-slate-600">Ranking</div>
              <div className="text-xl font-extrabold text-slate-900">
                {feed?.electionName ? feed.electionName : "Seuraavat vaalit"}
              </div>
              {feed?.lastUpdated ? (
                <div className="text-xs text-slate-600">
                  Feed päivitetty: <span className="text-slate-800">{feed.lastUpdated}</span>
                </div>
              ) : null}
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Hae ehdokas / puolue…"
              className="w-full md:w-[320px] rounded-2xl border border-slate-900/10 bg-white px-3 py-3 text-sm text-slate-900"
            />
          </div>

          <div className="relative z-0 mt-4 grid gap-3">
            {!computed ? (
              <div className="text-sm text-slate-600">Lataa vaali nähdäksesi rankingin.</div>
            ) : filtered.length === 0 ? (
              <div className="text-sm text-slate-600">Ei hakutuloksia.</div>
            ) : (
              filtered.map((s, idx) => (
                <button
                  key={s.candidate.id}
                  type="button"
                  onClick={() => setSelectedCandidateId(s.candidate.id)}
                  className="relative z-10 rounded-3xl border border-slate-900/10 bg-white/70 backdrop-blur px-4 py-4 text-left hover:bg-white [&_*]:pointer-events-none"
                >

                  <div className="grid grid-cols-[52px_1fr] md:grid-cols-[52px_1fr_200px] gap-3 items-start md:items-center">
                    <div className="h-12 w-12 rounded-2xl bg-slate-900/5 border border-slate-900/10 overflow-hidden grid place-items-center font-black text-slate-900">
                      {s.candidate.photoUrl ? (
                        <img src={s.candidate.photoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span>{idx + 1}</span>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-extrabold text-slate-900 truncate">{s.candidate.name}</div>
                        {s.candidate.party ? (
                          <span className="rounded-full border border-slate-900/10 bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                            {s.candidate.party}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1 text-xs text-slate-600">
                        {s.points} / {s.maxPoints} pistettä • {s.pct}% avoimuus
                      </div>

                      {/* Sortino-like “status strip” */}
                      <DocStrip perItem={s.perItem} />
                    </div>

                    <div className="mt-3 md:mt-0 md:text-right md:self-center">
                      <ProgressBar value={s.pct} />
                      <div className="mt-2 text-xs font-bold text-slate-700">Katso tiedot →</div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="mt-8 border-t border-slate-900/10 pt-4 text-xs text-slate-600 flex flex-wrap justify-between gap-3">
            <div>
              <b className="text-slate-900">Storage-free:</b> pisteytys tapahtuu selaimessa. Linkit vievät ulkoisiin lähteisiin.
            </div>
            <div>Vihje ehdokkaille: julkaise dokumentit (mieluiten redaktioituna) ja lisää pysyvä linkki.</div>
          </div>
        </div>
      </main>

      {/* Candidate modal */}
      <Modal
        open={!!selected}
        onClose={() => setSelectedCandidateId(null)}
        title={
          selected ? `${selected.candidate.name}${selected.candidate.party ? ` — ${selected.candidate.party}` : ""}` : ""
        }
      >
        {selected ? (
          <>
            <div className="flex flex-wrap gap-2 mb-4">
              <span className="rounded-full border border-slate-900/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                Avoimuus: <b className="text-slate-900">{selected.pct}%</b>
              </span>
              <span className="rounded-full border border-slate-900/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                Pisteet: <b className="text-slate-900">{selected.points}/{selected.maxPoints}</b>
              </span>
              {feed?.electionDay ? (
                <span className="rounded-full border border-slate-900/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700">
                  Cutoff (vaalipäivä): <b className="text-slate-900">{feed.electionDay}</b>
                </span>
              ) : null}
              {selected.candidate.website ? (
                <a
                  href={selected.candidate.website}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-slate-900/10 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  🌐 kotisivu
                </a>
              ) : null}
            </div>

            <div className="grid gap-3">
              {(Object.keys(items) as DisclosureKey[]).map((k) => {
                const row = selected.perItem[k];
                const label = items[k].label;
                const desc = items[k].description;

                return (
                  <div key={k} className="rounded-2xl border border-slate-900/10 bg-white p-4">
                    <div className="flex flex-wrap justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-extrabold text-slate-900">{label}</div>
                        <div className="mt-1 text-xs text-slate-600">{desc}</div>
                      </div>
                      <span
                        className={
                          row.has
                            ? "rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700"
                            : "rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700"
                        }
                      >
                        {row.has ? `✅ +${row.points}` : "❌ +0"}
                      </span>
                    </div>

                    {row.has && row.evidence ? (
                      <div className="mt-3 text-sm">
                        <a
                          href={row.evidence.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-slate-900 underline underline-offset-4"
                        >
                          Todiste ({safeHost(row.evidence.url)})
                        </a>
                        <div className="mt-1 text-xs text-slate-600">
                          Julkaistu: <b className="text-slate-900">{row.evidence.disclosedOn}</b>
                        </div>
                        {row.evidence.note ? <div className="mt-1 text-xs text-slate-600">{row.evidence.note}</div> : null}
                      </div>
                    ) : (
                      <div className="mt-3 text-xs text-slate-600">Ei qualifying-julkaisua ennen vaalipäivää.</div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </Modal>

      {/* How it works modal */}
      <Modal open={howOpen} onClose={() => setHowOpen(false)} title="Miten ehdokas.site toimii?">
        <div className="grid gap-3 text-sm text-slate-700">
          <div className="rounded-2xl border border-slate-900/10 bg-white p-4">
            <b className="text-slate-900">1) Julkinen vaali-indeksi</b>
            <div className="mt-2">
              Sivusto lukee tiedoston <code>/elections/index.json</code>, joka listaa tulevat vaalit ja niiden feed-URL:t.
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/10 bg-white p-4">
            <b className="text-slate-900">2) Per-vaali feed.json</b>
            <div className="mt-2">
              Jokaisella vaalilla on oma <code>feed.json</code>, jossa on ehdokkaat ja todiste-linkit (URL + disclosedOn).
              Pisteet lasketaan selaimessa.
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/10 bg-white p-4">
            <b className="text-slate-900">3) Cutoff = vaalipäivä</b>
            <div className="mt-2">
              Dokumentti lasketaan mukaan vain, jos sen <code>disclosedOn</code> on <b>vaalipäivänä tai ennen</b>.
            </div>
          </div>

          <div className="rounded-2xl border border-slate-900/10 bg-white p-4">
            <b className="text-slate-900">Ei tallennusta</b>
            <div className="mt-2">
              Ehdokas.site ei tallenna materiaalia. Se näyttää vain julkiset linkit ja laskee pisteet muistissa.
              Huom: linkin kohdesivusto voi lokittaa käynnin.
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
