// Go anywhere: press Ctrl K (or Cmd K) and type a few letters of a module,
// a week, a reading or a question. Arrow keys choose, Enter opens.

import { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/db";
import { placesOf } from "../lib/library";
import { sessionLabel, weekCode, titleAfter } from "../lib/modules";
import { navigate, type Route } from "../lib/router";
// Go to matches loosely: every word typed appears somewhere, so "319 at4
// sem" finds the HY319 AT4 seminar. Search proper stays strict.
// Curly quotes match straight ones, so "napoleon's" finds "Napoleon’s".
const fold = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019]/g, "'").toLowerCase();
function matches(text: string, query: string): boolean {
  const hay = fold(text);
  return fold(query).split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}
import { fullTitle, shortTitle } from "../lib/titles";

interface Entry { key: string; kind: string; label: string; detail?: string; route: Route; text: string; rank: number }

async function entries(): Promise<Entry[]> {
  const out: Entry[] = [];
  const modules = new Map((await db.modules.toArray()).filter((m) => !m.deleted).map((m) => [m.id, m]));
  for (const m of modules.values()) {
    out.push({ key: `m${m.id}`, kind: "Module", label: m.code, detail: m.title ?? undefined, route: { view: "module", id: m.id }, text: `${m.code} ${m.title ?? ""}`, rank: 0 });
  }
  for (const w of (await db.weeks.toArray()).filter((w) => !w.deleted)) {
    const m = modules.get(w.module_id);
    if (!m) continue;
    out.push({
      key: `w${w.id}`, kind: "Week", label: `${m.code} ${weekCode(w)}`, detail: w.title ?? (w.is_reading_week ? "Reading week" : undefined),
      route: { view: "week", id: w.id }, text: `${m.code} ${weekCode(w)}${titleAfter(w)}`, rank: 1,
    });
  }
  // Each session's notes, so "319 at3 lec" goes straight to them.
  const weeks = new Map((await db.weeks.toArray()).filter((w) => !w.deleted).map((w) => [w.id, w]));
  for (const session of (await db.sessions.toArray()).filter((x) => !x.deleted)) {
    const w = weeks.get(session.week_id);
    const m = w && modules.get(w.module_id);
    if (!w || !m) continue;
    const name = session.title || sessionLabel(session.kind);
    out.push({
      key: `s${session.id}`, kind: "Notes", label: `${m.code} ${weekCode(w)} ${name}`, detail: w.title ?? undefined,
      route: { view: "session", id: session.id }, text: `${m.code} ${weekCode(w)} ${name} ${session.kind} notes ${w.title ?? ""}`, rank: 1,
    });
  }
  const items = (await db.items.toArray()).filter((i) => !i.deleted);
  const places = await placesOf(items.map((i) => i.id));
  for (const i of items) {
    const place = places.get(i.id);
    if (!place) continue;
    out.push({
      key: `i${i.id}`, kind: i.kind === "slides" ? "Slides" : i.kind === "primary" ? "Source" : "Reading", label: shortTitle(i), detail: place.label,
      route: { view: "reader", id: i.id }, text: `${fullTitle(i)} ${place.label}`, rank: i.last_opened_at ? 2 : 3,
    });
  }
  for (const q of (await db.questions.toArray()).filter((q) => !q.deleted)) {
    out.push({ key: `q${q.id}`, kind: "Question", label: q.body, route: { view: "session", id: q.session_id }, text: q.body, rank: 4 });
  }
  out.push(
    { key: "a-search", kind: "Go to", label: "Search", route: { view: "search" }, text: "search find", rank: 5 },
    { key: "a-across", kind: "Go to", label: "Week across modules", route: { view: "across" }, text: "week across modules", rank: 5 },
    { key: "a-settings", kind: "Go to", label: "Settings", route: { view: "settings" }, text: "settings appearance light dark", rank: 5 },
  );
  return out;
}

export function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState<Entry[]>([]);
  const [index, setIndex] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    const openIt = () => setOpen(true);
    window.addEventListener("open-palette", openIt);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("open-palette", openIt); };
  }, []);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open) {
      setQuery("");
      setIndex(0);
      void entries().then(setAll);
      if (!d.open) d.showModal();
    } else if (d.open) d.close();
  }, [open]);

  const shown = useMemo(() => {
    if (!query.trim()) return all.filter((e) => e.rank <= 2 || e.rank === 5).sort((a, b) => a.rank - b.rank).slice(0, 40);
    const found = all.filter((e) => matches(e.text, query)).sort((a, b) => a.rank - b.rank).slice(0, 39);
    // Searching inside readings, notes and transcripts is always one step away.
    return [...found, { key: "a-find", kind: "Search", label: `Search everything for "${query.trim()}"`, route: { view: "search", q: query.trim() } as Route, text: "", rank: 6 }];
  }, [all, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    setOpen(false);
    navigate(entry.route);
  };

  return (
    <dialog ref={dialog} className="dialog palette" onCancel={(e) => { e.preventDefault(); setOpen(false); }} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <input
        type="search" autoFocus value={query} placeholder="Go to notes, a module, week, reading or question" aria-label="Go to"
        inputMode="search" enterKeyHint="go" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(shown.length - 1, i + 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
          if (e.key === "Enter") { e.preventDefault(); go(shown[index]); }
          // A search field's first Esc only clears it. Here Esc always closes.
          if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
        }}
      />
      <ul ref={list} className="palette-list" role="listbox" aria-label="Places">
        {shown.map((e, i) => (
          <li key={e.key} role="option" aria-selected={i === index} data-index={i} onMouseMove={() => setIndex(i)} onClick={() => go(e)}>
            <span className="kind">{e.kind}</span>
            <span className="label">{e.label}</span>
            {e.detail && <span className="where">{e.detail}</span>}
          </li>
        ))}
      </ul>
      <p className="palette-foot small muted"><kbd>↑</kbd> <kbd>↓</kbd> to choose, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close</p>
    </dialog>
  );
}
