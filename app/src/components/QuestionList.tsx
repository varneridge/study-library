// Seminar questions, typed straight into the page as you would type notes.
// Enter starts the next question, Backspace on an empty one removes it,
// Alt with an arrow moves one up or down, and a pasted list becomes one
// question per line. Each question opens to its own page for evidence and
// an answer.

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NoteEditorHandle } from "./NoteEditor";
import { Link } from "../App";
import { db } from "../lib/db";
import { deleteQuestion, moveQuestion, withUndo } from "../lib/edits";
import { byPosition, keyBetween } from "../lib/keys";
import type { QuestionView } from "../lib/library";
import { commit, newId, update } from "../lib/sync";
import { splitQuestions } from "../lib/notes";
import type { QuestionRow } from "../lib/types";

// "1. What was…" and "a) Why…" lose their numbering; blank lines go.

async function siblings(sessionId: string): Promise<QuestionRow[]> {
  return (await db.questions.where("session_id").equals(sessionId).toArray()).filter((q) => !q.deleted).sort(byPosition);
}

// Puts new questions after a given one, or at the end.
async function insertAfter(sessionId: string, after: QuestionRow | null, bodies: string[], ids: string[] = []): Promise<string[]> {
  const list = await siblings(sessionId);
  const at = after ? list.findIndex((q) => q.id === after.id) : list.length - 1;
  let before = at >= 0 ? list[at].position : null;
  const next = list[at + 1]?.position ?? null;
  const rows = bodies.map((body, i) => {
    const position = keyBetween(before, next);
    before = position;
    return { id: ids[i] ?? newId(), session_id: sessionId, body, position };
  });
  await commit(rows.map((row) => ({ table: "questions" as const, row })));
  return rows.map((r) => r.id);
}

function grow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

const NoteEditor = lazy(() => import("./NoteEditor"));

// A question's answer, written straight beneath it in the same editor as
// the session's notes. Editors start once they are near the screen, so a
// long list of questions opens as quickly as a short one.
function Answer({ questionId, number, handle }: { questionId: string; number: number; handle: React.Ref<NoteEditorHandle> }) {
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || shown) return;
    if (typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); observer.disconnect(); }
    }, { rootMargin: "600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);
  const waiting = <div className="answer-loading" aria-hidden="true" />;
  return (
    <div ref={box} className="question-answer" role="group" aria-label={`Answer to question ${number}`}>
      {shown ? (
        <Suspense fallback={waiting}>
          <NoteEditor target={{ question_id: questionId }} handle={handle} placeholder="Answer" compact label={`Answer to question ${number}`} />
        </Suspense>
      ) : waiting}
    </div>
  );
}

type Where = "start" | "end";
type Target = string | "prev" | "next" | null;
// Puts the cursor in a question, with any text typed while it was being made.
type Focuser = (where: Where, typed?: string) => void;

function Row({ view, index, count, move, register, hold }: {
  view: QuestionView; index: number; count: number;
  move: (target: Target, where: Where) => void;
  register: (id: string, fn: Focuser | null) => void;
  // While a new question is on its way, keys typed go to it, not here.
  hold: { start: (id: string, where: Where) => void; active: () => boolean; type: (key: string) => void };
}) {
  const { question, filed, answered } = view;
  const [text, setText] = useState(question.body);
  const answer = useRef<NoteEditorHandle>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Another device's change shows, unless you are typing in this question.
  useEffect(() => { if (!focused.current) setText(question.body); }, [question.body]);
  useLayoutEffect(() => grow(field.current), [text]);
  useEffect(() => {
    register(question.id, (where, typed) => {
      const el = field.current;
      if (!el) return;
      el.focus();
      if (typed) {
        const value = where === "start" ? typed + el.value : el.value + typed;
        setText(value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => save(value), 700);
        const at = where === "start" ? typed.length : value.length;
        requestAnimationFrame(() => el.setSelectionRange(at, at));
        return;
      }
      const at = where === "start" ? 0 : el.value.length;
      el.setSelectionRange(at, at);
    });
    return () => register(question.id, null);
  }, [question.id, register]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const save = (value = text) => {
    clearTimeout(timer.current);
    const body = value.replace(/\s+/g, " ").trim();
    if (body && body !== question.body) void update("questions", question.id, { body });
  };

  return (
    <li className="question-row">
      <textarea
        ref={field}
        rows={1}
        enterKeyHint="next"
        value={text}
        aria-label={`Question ${index + 1}`}
        placeholder="Write the question"
        onFocus={() => { focused.current = true; }}
        onBlur={() => {
          focused.current = false;
          // A question left empty, with nothing filed under it, is not kept.
          if (!text.trim() && !filed && !answered) void deleteQuestion(question);
          else save();
        }}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => save(value), 700);
        }}
        onPaste={async (e) => {
          const lines = splitQuestions(e.clipboardData.getData("text"));
          if (lines.length < 2) return;
          e.preventDefault();
          // The first pasted line joins this question; the rest follow it.
          const first = `${text}${lines[0]}`;
          setText(first);
          save(first);
          const ids = await insertAfter(question.session_id, question, lines.slice(1));
          move(ids.at(-1) ?? null, "end");
        }}
        onKeyDown={async (e) => {
          const el = e.currentTarget;
          if (hold.active()) {
            // The next question is being made. Typing waits for it.
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) hold.type(e.key);
            if (e.key !== "Shift") e.preventDefault();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            // Enter splits the question at the cursor, as it would a line of notes.
            const head = el.value.slice(0, el.selectionStart).trim();
            const tail = el.value.slice(el.selectionEnd).trim();
            if (!head && !tail) return;
            const id = newId();
            hold.start(id, "start");
            if (head) { setText(head); save(head); }
            await insertAfter(question.session_id, question, [tail], [id]);
            move(id, "start");
          } else if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0 && !el.value.trim()) {
            e.preventDefault();
            move(index > 0 ? "prev" : "next", "end");
            // A question with evidence or an answer goes with an undo.
            if (filed > 0 || answered) await withUndo("Question deleted.", deleteQuestion(question));
            else await deleteQuestion(question);
          } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
            e.preventDefault();
            save();
            await moveQuestion(question, e.key === "ArrowUp" ? -1 : 1);
            requestAnimationFrame(() => field.current?.focus());
          } else if (e.key === "ArrowUp" && el.selectionStart === 0 && el.selectionEnd === 0 && index > 0) {
            e.preventDefault();
            move("prev", "end");
          } else if (e.key === "ArrowDown" && el.selectionEnd === el.value.length) {
            e.preventDefault();
            // Down from the end of a question goes into its answer.
            if (answer.current) answer.current.focus();
            else move(index < count - 1 ? "next" : null, "start");
          }
        }}
      />
      <Answer questionId={question.id} number={index + 1} handle={answer} />
    </li>
  );
}

export function QuestionList({ sessionId, questions, always = false }: { sessionId: string; questions: QuestionView[]; always?: boolean }) {
  const focusers = useRef(new Map<string, Focuser>());
  const pending = useRef<{ id: string; where: Where; typed: string; since?: number } | null>(null);
  const [draft, setDraft] = useState("");
  const adder = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => grow(adder.current), [draft]);

  const register = useRef((id: string, fn: Focuser | null) => {
    if (fn) {
      focusers.current.set(id, fn);
      // A question just made takes the cursor once it is on the page.
      const waiting = pending.current;
      if (waiting?.id === id) { pending.current = null; fn(waiting.where, waiting.typed); }
    } else focusers.current.delete(id);
  }).current;

  const hold = useRef({
    start: (id: string, where: Where) => { pending.current = { id, where, typed: "", since: Date.now() }; },
    // A question that never arrives lets go after a second and a half.
    active: () => {
      const waiting = pending.current;
      if (waiting?.since && Date.now() - waiting.since > 1500) pending.current = null;
      return Boolean(pending.current?.since);
    },
    type: (key: string) => { if (pending.current) pending.current.typed += key; },
  }).current;

  const moveFrom = (index: number) => (target: Target, where: Where) => {
    let id: string | null = target;
    if (target === "prev") id = questions[index - 1]?.question.id ?? null;
    if (target === "next") id = questions[index + 1]?.question.id ?? null;
    if (!id) { adder.current?.focus(); return; }
    const fn = focusers.current.get(id);
    const typed = pending.current?.id === id ? pending.current.typed : "";
    if (fn) { pending.current = null; fn(where, typed); }
    else pending.current = { id, where, typed };
  };

  const addDraft = async (value: string) => {
    const lines = splitQuestions(value);
    if (!lines.length) return;
    setDraft("");
    await insertAfter(sessionId, null, lines);
  };

  if (!questions.length && !always) return null;
  return (
    <ol className="questions live">
      {questions.map((q, i) => (
        <Row key={q.question.id} view={q} index={i} count={questions.length} move={moveFrom(i)} register={register} hold={hold} />
      ))}
      <li className="question-row adder">
        <textarea
          ref={adder}
          rows={1}
          enterKeyHint="next"
          value={draft}
          aria-label="Add a question"
          placeholder={questions.length ? "Add a question" : "Type or paste the seminar questions, one per line"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void addDraft(draft)}
          onPaste={(e) => {
            const lines = splitQuestions(e.clipboardData.getData("text"));
            if (lines.length < 2) return;
            e.preventDefault();
            void addDraft([draft, ...lines].join("\n"));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void addDraft(draft).then(() => adder.current?.focus());
            } else if (e.key === "ArrowUp" && e.currentTarget.selectionStart === 0 && questions.length) {
              e.preventDefault();
              focusers.current.get(questions[questions.length - 1].question.id)?.("end");
            }
          }}
        />
      </li>
    </ol>
  );
}
