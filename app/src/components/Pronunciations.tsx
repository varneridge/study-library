// The course dictionary in Settings: words Listen says wrongly, and how they
// should sound, typed as plain respellings. Entries sync like other settings
// and reach every reading, in the browser's voice and in prepared audio.

import { useRef, useState } from "react";
import type { PronunciationEntry } from "../lib/listen/annotate";
import { respellingProblem as pronunciationProblem } from "../lib/listen/respell";
import { deletePronunciation, savePronunciation, usePronunciations } from "../lib/listen/pronunciations";
import { showToast } from "../lib/ui";

function EntryForm({
  initial,
  submitLabel,
  onDone,
  onCancel,
}: {
  initial: PronunciationEntry;
  submitLabel: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [word, setWord] = useState(initial.word);
  const [say, setSay] = useState(initial.say);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wordField = useRef<HTMLInputElement>(null);

  async function submit() {
    const found = pronunciationProblem(word, say);
    setProblem(found);
    if (found || busy) return;
    setBusy(true);
    try {
      await savePronunciation({ word, say }, initial.word || undefined);
      showToast(`Listen will say \u201c${word.trim()}\u201d as ${say.trim()}.`);
      setWord("");
      setSay("");
      onDone();
      wordField.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="pronunciation-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onCancel) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="field">
        <span>Word</span>
        <input ref={wordField} value={word} autoFocus={!!onCancel} autoComplete="off" spellCheck={false} placeholder="Ussuri" onChange={(e) => setWord(e.target.value)} />
      </label>
      <label className="field">
        <span>Sounds like</span>
        <input value={say} autoComplete="off" spellCheck={false} placeholder="oo-SOO-ree" onChange={(e) => setSay(e.target.value)} />
      </label>
      <div className="pronunciation-actions">
        <button type="submit" className="button" disabled={busy}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

export function Pronunciations() {
  const entries = usePronunciations();
  const [editing, setEditing] = useState<string | null>(null);
  if (!entries) return null;

  async function remove(entry: PronunciationEntry) {
    await deletePronunciation(entry.word);
    showToast(`Removed the pronunciation of \u201c${entry.word}\u201d.`, {
      label: "Undo",
      run: () => savePronunciation(entry),
    });
  }

  return (
    <>
      <h2>Pronunciations</h2>
      <p className="small muted">
        How Listen should say words it gets wrong, in every reading. Type how a word sounds with hyphens between syllables and the stressed one in
        capitals, such as oo-SOO-ree for Ussuri. Chinese names in pinyin are already read correctly.
      </p>
      <EntryForm initial={{ word: "", say: "" }} submitLabel="Add pronunciation" onDone={() => {}} />
      {entries.length === 0 ? (
        <p className="small muted">No pronunciations yet. Add a word above and Listen will say it that way from then on.</p>
      ) : (
        <ul className="list pronunciation-list">
          {entries.map((entry) =>
            editing === entry.word ? (
              <li key={entry.word} className="is-editing">
                <EntryForm initial={entry} submitLabel="Save" onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
              </li>
            ) : (
              <li key={entry.word}>
                <span className="pronunciation-word">{entry.word}</span>
                <span className="pronunciation-say">{entry.say}</span>
                <button className="quiet" onClick={() => setEditing(entry.word)}>
                  Edit
                </button>
                <button className="quiet danger" onClick={() => void remove(entry)}>
                  Delete
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </>
  );
}
