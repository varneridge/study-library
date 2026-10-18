// An imported transcript set out for reading: one block per turn, a new
// block only when the speaker changes, long turns broken into paragraphs.
// Speakers can be named once and the names follow the transcript everywhere.

import { useEffect, useMemo, useRef, useState } from "react";
import { clock } from "../lib/recorder";
import { setSetting, useSetting } from "../lib/settings";
import { paragraphs, speakerLabel, tidy } from "../lib/transcriptImport";
import type { Turn } from "../lib/types";

const TIDY = "transcript-tidy";

function Marked({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} className="t-hit">{p}</mark> : p))}</>;
}

// The chatter before a lecture starts: a run of short turns ahead of the
// first long one. It is folded away, and one click shows it.
function preamble(turns: Turn[]): number {
  const firstLong = turns.findIndex((t) => t.text.split(/\s+/).length > 250);
  if (firstLong < 4) return 0;
  const before = turns.slice(0, firstLong);
  const words = (t: Turn) => t.text.split(/\s+/).length;
  const total = turns.reduce((n, t) => n + words(t), 0);
  // Short turns only, and only a small part of the whole.
  return before.every((t) => words(t) < 150) && before.reduce((n, t) => n + words(t), 0) < total * 0.08 ? firstLong : 0;
}

export function TranscriptView({ recordingId, turns, title, focusTurn }: {
  recordingId: string; turns: Turn[]; title: string; focusTurn?: number;
}) {
  const names = useSetting<Record<string, string>>(`speakers:${recordingId}`, {});
  const [clean, setClean] = useState(() => localStorage.getItem(TIDY) !== "off");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [showPreamble, setShowPreamble] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const speakers = useMemo(() => [...new Set(turns.map((t) => t.speaker))], [turns]);
  // A transcript of a recording has no speakers marked: it reads as one text.
  const named = speakers.some((s) => s.trim());
  const words = useMemo(() => turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0), [turns]);
  const fold = preamble(turns);
  const needle = query.trim().length > 1 ? query.trim() : "";

  const shown = useMemo(() => turns.map((t, i) => ({
    index: i,
    speaker: t.speaker,
    start: t.start ?? null,
    paras: paragraphs(clean ? tidy(t.text) : t.text),
  })), [turns, clean]);

  const count = useMemo(() => {
    if (!needle) return 0;
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return shown.slice(showPreamble ? 0 : fold).reduce((n, t) => n + t.paras.reduce((m, p) => m + (p.match(re)?.length ?? 0), 0), 0);
  }, [shown, needle, fold, showPreamble]);

  useEffect(() => setHit(0), [needle]);
  useEffect(() => {
    const marks = body.current?.querySelectorAll<HTMLElement>("mark.t-hit");
    marks?.forEach((m, i) => m.classList.toggle("current", i === hit));
    marks?.[hit]?.scrollIntoView({ block: "center" });
  }, [hit, needle, count]);

  useEffect(() => {
    if (focusTurn === undefined) return;
    if (focusTurn < fold) setShowPreamble(true);
    requestAnimationFrame(() => body.current?.querySelector(`[data-turn="${focusTurn}"]`)?.scrollIntoView({ block: "start" }));
  }, [focusTurn, fold]);

  const saveName = (speaker: string) => {
    setRenaming(null);
    const next = { ...names, [speaker]: draft.trim() };
    if (!draft.trim()) delete next[speaker];
    void setSetting(`speakers:${recordingId}`, next);
  };

  const download = () => {
    const text = turns.map((t) => `${named ? `${speakerLabel(t.speaker, names)}\n` : ""}${paragraphs(clean ? tidy(t.text) : t.text).join("\n\n")}`).join("\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const colour = (speaker: string) => `s${speakers.indexOf(speaker) % 6}`;

  return (
    <div className="moodle-transcript">
      <div className="t-head">
        <p className="t-meta small muted">
          {named && `${speakers.length} ${speakers.length === 1 ? "speaker" : "speakers"}, `}{words.toLocaleString("en-GB")} words · about {Math.max(1, Math.round(words / 230))} minutes to read
        </p>
        {named && <ul className="t-speakers" aria-label="Speakers">
          {speakers.map((s) => (
            <li key={s} className={colour(s)}>
              {renaming === s ? (
                <input
                  type="text" autoFocus value={draft} aria-label={`Name for ${speakerLabel(s, {})}`} placeholder={speakerLabel(s, {})}
                  onChange={(e) => setDraft(e.target.value)} onBlur={() => saveName(s)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(s); if (e.key === "Escape") setRenaming(null); }}
                />
              ) : (
                <button className="plain" title="Give this speaker a name" onClick={() => { setDraft(names[s] ?? ""); setRenaming(s); }}>
                  {speakerLabel(s, names)}
                </button>
              )}
            </li>
          ))}
        </ul>}
        <div className="t-tools">
          <input type="search" placeholder="Find in transcript" aria-label="Find in transcript" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && count) setHit((h) => (h + (e.shiftKey ? count - 1 : 1)) % count); }} />
          {needle && <span className="small muted">{count ? `${hit + 1} of ${count}` : "No matches"}</span>}
          <span className="spacer" />
          <label className="choices small">
            <input type="checkbox" checked={clean} onChange={(e) => { setClean(e.target.checked); localStorage.setItem(TIDY, e.target.checked ? "on" : "off"); }} />
            Leave out ums and repeats
          </label>
          <button className="quiet" onClick={download}>Download</button>
        </div>
      </div>

      <div className="t-body" ref={body}>
        {fold > 0 && !showPreamble && (
          <button className="t-fold" onClick={() => setShowPreamble(true)}>
            {fold} short exchanges before the lecture began. Show them
          </button>
        )}
        {shown.slice(showPreamble ? 0 : fold).map((t) => (
          <article key={t.index} className={`turn ${colour(t.speaker)}${named ? "" : " plain"}`} data-turn={t.index}>
            {named && <header>
              <span className="who">{speakerLabel(t.speaker, names)}</span>
              {t.start != null && <span className="when">{clock(t.start)}</span>}
            </header>}
            {t.paras.map((p, i) => <p key={i}><Marked text={p} needle={needle} /></p>)}
          </article>
        ))}
      </div>
    </div>
  );
}
