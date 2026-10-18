import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { Link } from "../App";
import { db } from "../lib/db";
import { byPosition } from "../lib/keys";
import { clock } from "../lib/recorder";
import { href, navigate, type Route } from "../lib/router";
import {
  MARK_END, MARK_START, searchLocal, searchRemote, type LocalResults, type RemoteResults,
} from "../lib/search";
import { fullTitle, shortTitle } from "../lib/titles";
import { useTitle } from "../lib/ui";

type Kind = "all" | "readings" | "highlights" | "notes" | "recordings";
const KINDS: { value: Kind; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "readings", label: "Readings" },
  { value: "highlights", label: "Highlights" },
  { value: "notes", label: "Notes" },
  { value: "recordings", label: "Recordings" },
];
const STEP = 40;
const RECENT = "recent-searches";

function recentSearches(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[]; } catch { return []; }
}

// Remembers a search once it has sat in the box for a moment with results.
function remember(query: string) {
  const q = query.trim();
  if (q.length < 3) return;
  const list = [q, ...recentSearches().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
  localStorage.setItem(RECENT, JSON.stringify(list));
}

function Snippet({ text }: { text: string }) {
  const parts = text.split(new RegExp(`(${MARK_START}[^${MARK_END}]*${MARK_END})`));
  return (
    <span className="snippet">
      {parts.map((part, i) => (part.startsWith(MARK_START) ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>))}
    </span>
  );
}

function Where({ label }: { label?: string | null }) {
  return label ? <span className="where">{label}</span> : null;
}

const EMPTY_LOCAL: LocalResults = { titles: [], highlights: [], notes: [] };
const EMPTY_REMOTE: RemoteResults = { pages: [], transcripts: [], more: false };

export function SearchPage({ q = "" }: { q?: string }) {
  const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const [query, setQuery] = useState(q);
  const [kind, setKind] = useState<Kind>("all");
  const [moduleId, setModuleId] = useState("");
  const [limit, setLimit] = useState(STEP);
  const [local, setLocal] = useState<LocalResults>(EMPTY_LOCAL);
  const [remote, setRemote] = useState<RemoteResults>(EMPTY_REMOTE);
  const [offline, setOffline] = useState(false);
  const [searching, setSearching] = useState(false);
  const [, refresh] = useState(0);
  const first = useRef<Route | null>(null);
  const modules = useLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted).sort(byPosition), [], []);
  useTitle(query ? `Search: ${query}` : "Search");

  useEffect(() => setLimit(STEP), [query]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      navigate({ view: "search", q: query || undefined }, true);
      setOffline(!navigator.onLine);
      setSearching(true);
      const [l, r] = await Promise.all([
        searchLocal(query),
        searchRemote(query, limit).catch(() => EMPTY_REMOTE),
      ]);
      if (cancelled) return;
      setLocal(l);
      setRemote(r);
      setSearching(false);
      if (l.titles.length + l.highlights.length + l.notes.length + r.pages.length + r.transcripts.length) remember(query);
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, limit]);

  const inModule = (id: string | null | undefined) => !moduleId || id === moduleId;
  const show = (k: Kind) => kind === "all" || kind === k;
  const titles = show("readings") ? local.titles.filter((h) => inModule(h.place?.module.id)) : [];
  const highlights = show("highlights") ? local.highlights.filter((h) => inModule(h.place?.module.id)) : [];
  const notes = show("notes") ? local.notes.filter((h) => inModule(h.module?.id)) : [];
  const pages = show("readings") ? remote.pages.filter((h) => inModule(h.place?.module.id)) : [];
  const transcripts = show("recordings") ? remote.transcripts.filter((h) => inModule(h.module?.id)) : [];
  const total = titles.length + highlights.length + notes.length + pages.length + transcripts.length;
  const nothing = query.trim() && !searching && total === 0;

  // Enter opens the first result, in the order shown.
  first.current =
    (titles[0] && { view: "reader", id: titles[0].item.id }) ||
    (highlights[0] && { view: "reader", id: highlights[0].item.id, page: highlights[0].highlights[0].highlight.page }) ||
    (notes[0] && notes[0].route) ||
    (pages[0] && { view: "reader", id: pages[0].item.id, page: pages[0].pages[0].page, q: query }) ||
    (transcripts[0] && (transcripts[0].imported
      ? { view: "session", id: transcripts[0].sessionId, turn: transcripts[0].hits[0].start }
      : { view: "session", id: transcripts[0].sessionId, t: transcripts[0].hits[0].start })) ||
    null;

  return (
    <div className="page search-page">
      <h1 className="sr-only">Search</h1>
      <input
        // On a touch screen the keyboard waits for a tap on the field, as in iOS's own search.
        type="search" autoFocus={!coarse} value={query} placeholder="Search readings, notes, highlights and transcripts"
        aria-label="Search" inputMode="search" enterKeyHint="search" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && first.current) navigate(first.current); }}
        className="search-box"
      />
      <div className="search-filters">
        <div className="segmented" role="group" aria-label="Show">
          {KINDS.map((k) => (
            <button key={k.value} className="tool" aria-pressed={kind === k.value} onClick={() => setKind(k.value)}>{k.label}</button>
          ))}
        </div>
        {modules.length > 1 && (
          <select aria-label="Module" value={moduleId} onChange={(e) => setModuleId(e.target.value)} style={{ width: "auto" }}>
            <option value="">All modules</option>
            {modules.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
          </select>
        )}
      </div>
      <p className="small muted search-help">
        Every word must match. Put a phrase in "quote marks" to find it as written.
        {offline && query && " Offline: showing titles, highlights and notes saved on this device."}
      </p>
      {nothing && <p className="muted section">Nothing matches that yet.</p>}
      {!query.trim() && recentSearches().length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Recent searches</h2>
            <span className="spacer" />
            <button className="quiet" onClick={() => { localStorage.removeItem(RECENT); refresh((n) => n + 1); }}>Clear</button>
          </div>
          <ul className="recent">
            {recentSearches().map((r) => (
              <li key={r}><button className="plain name" onClick={() => setQuery(r)}>{r}</button></li>
            ))}
          </ul>
        </section>
      )}

      {titles.length > 0 && (
        <section className="section">
          <h2>Readings</h2>
          <ul className="hits">
            {titles.map((h) => (
              <li key={h.item.id}>
                <div className="hit-head">
                  <Link to={{ view: "reader", id: h.item.id }}>{fullTitle(h.item)}</Link>
                  <Where label={h.place?.label} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {highlights.length > 0 && (
        <section className="section">
          <h2>Highlights</h2>
          <ul className="hits">
            {highlights.map((group) => (
              <li key={group.item.id}>
                <div className="hit-head">
                  <span className="hit-title">{shortTitle(group.item)}</span>
                  <Where label={group.place?.label} />
                </div>
                {group.highlights.map(({ highlight, text }) => (
                  <a
                    key={highlight.id} className="hit-line" href={href({ view: "reader", id: group.item.id, page: highlight.page })}
                    onClick={(e) => { e.preventDefault(); navigate({ view: "reader", id: group.item.id, page: highlight.page }); }}
                  >
                    <span className="at" style={{ borderColor: highlight.colour }}>p. {highlight.page + 1}</span>
                    <Snippet text={text} />
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
      {notes.length > 0 && (
        <section className="section">
          <h2>Notes</h2>
          <ul className="hits">
            {notes.map((group) => (
              <li key={group.key}>
                <div className="hit-head">
                  <Link to={group.route}>{group.label}</Link>
                  {group.count > group.snippets.length && <span className="where">{group.count} matches</span>}
                </div>
                {group.snippets.map((s, i) => <p key={i} className="hit-line plain"><Snippet text={s} /></p>)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {pages.length > 0 && (
        <section className="section">
          <h2>In the readings</h2>
          <ul className="hits">
            {pages.map((group) => (
              <li key={group.item.id}>
                <div className="hit-head">
                  <span className="hit-title">{shortTitle(group.item)}</span>
                  <Where label={group.place?.label} />
                </div>
                {group.pages.slice(0, 3).map((p) => (
                  <a
                    key={p.page} className="hit-line" href={href({ view: "reader", id: group.item.id, page: p.page, q: query })}
                    onClick={(e) => { e.preventDefault(); navigate({ view: "reader", id: group.item.id, page: p.page, q: query }); }}
                  >
                    <span className="at">p. {p.page + 1}</span>
                    <Snippet text={p.snippet} />
                  </a>
                ))}
                {group.pages.length > 3 && (
                  <p className="hit-more small">
                    Also on{" "}
                    {group.pages.slice(3).map((p, i) => (
                      <span key={p.page}>
                        {i > 0 && ", "}
                        <Link to={{ view: "reader", id: group.item.id, page: p.page, q: query }}>p. {p.page + 1}</Link>
                      </span>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {transcripts.length > 0 && (
        <section className="section">
          <h2>In recordings</h2>
          <ul className="hits">
            {transcripts.map((group) => (
              <li key={group.recordingId}>
                <div className="hit-head"><span className="hit-title">{group.label}</span></div>
                {group.hits.slice(0, 4).map((h, i) => {
                  const to: Route = group.imported
                    ? { view: "session", id: group.sessionId, turn: h.start }
                    : { view: "session", id: group.sessionId, t: h.start };
                  return (
                  <a
                    key={i} className="hit-line" href={href(to)}
                    onClick={(e) => { e.preventDefault(); navigate(to); }}
                  >
                    <span className="at">{group.imported ? h.who || "Transcript" : clock(h.start)}</span>
                    <Snippet text={h.snippet} />
                  </a>
                  );
                })}
                {group.hits.length > 4 && <p className="hit-more small">{group.hits.length - 4} more in this recording</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {remote.more && (show("readings") || show("recordings")) && (
        <p className="section"><button className="button" onClick={() => setLimit(limit + STEP * 2)}>Show more results</button></p>
      )}
    </div>
  );
}
