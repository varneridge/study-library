// Folding a seminar question's answer away and back. Each question remembers
// on this device whether it was open; a new one starts open, ready to answer.
// The answer's editor stays mounted while folded (hidden, not removed), so
// its undo history survives and unsaved typing is flushed by the editor's
// own blur handler when focus moves to the fold button (NoteEditor onBlur).

import { useCallback, useEffect, useState } from "react";
import { readQuestionOpen, writeQuestionOpen } from "../lib/questionFold";
import { Icon } from "./icons";
import "./questionFold.css";

const EVENT = "study:question-fold";

interface FoldAllDetail {
  ids: readonly string[];
  open: boolean;
}

export function useQuestionOpen(questionId: string): { open: boolean; setOpen: (open: boolean) => void; toggle: () => void } {
  const [open, setOpenState] = useState(() => readQuestionOpen(questionId));
  useEffect(() => setOpenState(readQuestionOpen(questionId)), [questionId]);
  const setOpen = useCallback((next: boolean) => {
    writeQuestionOpen(questionId, next);
    setOpenState(next);
  }, [questionId]);
  // "Fold all" and "Unfold all" reach every question listed in the event.
  useEffect(() => {
    const onAll = (e: Event) => {
      const detail = (e as CustomEvent<FoldAllDetail>).detail;
      if (detail?.ids.includes(questionId)) setOpen(detail.open);
    };
    window.addEventListener(EVENT, onAll);
    return () => window.removeEventListener(EVENT, onAll);
  }, [questionId, setOpen]);
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  return { open, setOpen, toggle };
}

export function QuestionFoldButton({ open, onToggle, controls, label }: { open: boolean; onToggle: () => void; controls: string; label: string }) {
  return (
    <button
      type="button"
      className="question-fold"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Hide ${label}` : `Show ${label}`}
      title={open ? "Hide the answer" : "Show the answer"}
      onClick={onToggle}
    >
      <Icon name="caret" size={14} />
    </button>
  );
}

// One control for the whole list: unfolds everything when anything is folded,
// otherwise folds everything.
export function QuestionsFoldAll({ ids }: { ids: readonly string[] }) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const on = () => rerender((n) => n + 1);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (ids.length < 2) return null;
  const anyFolded = ids.some((id) => !readQuestionOpen(id));
  return (
    <button
      type="button"
      className="quiet questions-fold-all"
      onClick={() => window.dispatchEvent(new CustomEvent<FoldAllDetail>(EVENT, { detail: { ids, open: anyFolded } }))}
    >
      {anyFolded ? "Show all answers" : "Hide all answers"}
    </button>
  );
}
