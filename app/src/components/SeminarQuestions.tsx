// A seminar's questions, typed in place. Each reads as a numbered line of the
// page with its answer beneath it, and each answer folds away so a long list
// stays readable. Typing a question and pressing Enter adds it; pasting a
// list adds one question per line.

import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { blockText, findNote, noteBlocks, type NoteTarget } from "../lib/notes";
import { answerPreview } from "../lib/questionFold";
import { addQuestions, orderedQuestions, renameQuestion, splitQuestions, type SeminarQuestion } from "../lib/seminarQuestions";
import type { Block } from "../lib/types";
import { showToast } from "../lib/ui";
import { QuestionFoldButton, QuestionsFoldAll, useQuestionOpen } from "./QuestionFold";

const NoteEditor = lazy(() => import("./NoteEditor"));

function fitHeight(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

// The answer's words, read only while the answer is folded, for its preview line.
function useAnswerText(questionId: string, wanted: boolean): string {
  return useLiveQuery(async () => {
    if (!wanted) return "";
    const note = await findNote({ question_id: questionId } as unknown as NoteTarget);
    if (!note) return "";
    const rows = await noteBlocks(note.id);
    return rows.map((r) => blockText(r.content as unknown as Block)).join(" ");
  }, [questionId, wanted], "") ?? "";
}

function QuestionItem({ question, number }: { question: SeminarQuestion; number: number }) {
  const currentBody = question.body ?? question.text ?? "";
  const { open, toggle } = useQuestionOpen(question.id);
  const [draft, setDraft] = useState(currentBody);
  const focused = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // Changes from other devices show at once, except while you are typing here.
  useEffect(() => { if (!focused.current) setDraft(question.body ?? question.text ?? ""); }, [question.body, question.text]);
  useEffect(() => fitHeight(field.current), [draft]);
  // A stable target, so the editor does not resubscribe on every render.
  const target = useMemo(() => ({ question_id: question.id }) as unknown as NoteTarget, [question.id]);
  const preview = answerPreview(useAnswerText(question.id, !open));
  const answerId = `answer-${question.id}`;

  const save = () => {
    focused.current = false;
    const text = draft.replace(/\s+/g, " ").trim();
    // A question cannot be emptied by accident, so clearing it puts it back.
    if (!text) {
      setDraft(currentBody);
      return;
    }
    if (text !== currentBody) {
      void renameQuestion(question.id, text).catch(() => showToast("The question could not be saved yet. Try again in a moment."));
    }
  };

  return (
    <li className="question-row">
      <QuestionFoldButton open={open} onToggle={toggle} controls={answerId} label={`the answer to question ${number}`} />
      <textarea
        ref={field}
        rows={1}
        value={draft}
        aria-label={`Question ${number}`}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          // Enter finishes the question rather than starting a new line in it.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
      {!open && preview && <span className="question-preview">{preview}</span>}
      <div id={answerId} className="question-answer" hidden={!open}>
        <Suspense fallback={<div className="answer-loading" aria-busy="true" />}>
          <NoteEditor target={target} compact label={`Answer to question ${number}`} placeholder="Your answer" />
        </Suspense>
      </div>
    </li>
  );
}

// The empty line at the foot of the list, where new questions are typed or pasted.
function QuestionAdder({ sessionId, last, number }: { sessionId: string; last: SeminarQuestion | undefined; number: number }) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => fitHeight(field.current), [draft]);

  const add = async (text: string) => {
    const texts = splitQuestions(text);
    if (!texts.length) return;
    setDraft("");
    try {
      await addQuestions(sessionId, texts, last);
      if (texts.length > 1) showToast(`${texts.length} questions added.`);
    } catch {
      setDraft(text);
      showToast("The questions could not be added. Try again in a moment.");
    }
  };

  return (
    <li className="question-row adder">
      <textarea
        ref={field}
        rows={1}
        value={draft}
        aria-label={`Question ${number}`}
        placeholder="Type a question, or paste a list of them"
        onChange={(e) => setDraft(e.target.value)}
        onPaste={(e) => {
          // A pasted list becomes one question a line, straight away.
          const pasted = e.clipboardData.getData("text/plain");
          if (splitQuestions(pasted).length > 1) {
            e.preventDefault();
            void add(`${draft}\n${pasted}`);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void add(draft);
          }
        }}
        onBlur={() => { if (draft.trim()) void add(draft); }}
      />
    </li>
  );
}

export function SeminarQuestions({ sessionId, questions }: { sessionId: string; questions: readonly SeminarQuestion[] | null | undefined }) {
  const list = orderedQuestions(questions);
  const ids = useMemo(() => list.map((q) => q.id), [list.map((q) => q.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="seminar-questions" aria-label="Seminar questions">
      <div className="section-head" style={{ alignItems: "baseline" }}>
        <h2 className="group-label">Seminar questions</h2>
        <QuestionsFoldAll ids={ids} />
      </div>
      <ol className="questions live">
        {list.map((q, index) => <QuestionItem key={q.id} question={q} number={index + 1} />)}
        <QuestionAdder sessionId={sessionId} last={list[list.length - 1]} number={list.length + 1} />
      </ol>
      {!list.length && <p className="small muted questions-hint">Each question gets its own answer beneath it, which folds away when you want the list short.</p>}
    </section>
  );
}
