// Seminar questions: splitting typed or pasted text into questions, and the
// writes that keep them.

import { byPosition, keyBetween } from "./keys";
import { insert, newId, update } from "./sync";

export { splitQuestions } from "./questionText";

export interface SeminarQuestion {
  id: string;
  body: string;
  text?: string;
  position: string;
  deleted?: boolean | number;
}

// The live questions in their order, deleted ones left out.
export function orderedQuestions(questions: readonly SeminarQuestion[] | null | undefined): SeminarQuestion[] {
  return (questions ?? []).filter((q) => !q.deleted).sort(byPosition);
}

// Adds questions after the last one, in the order given.
export async function addQuestions(sessionId: string, bodies: readonly string[], after: SeminarQuestion | undefined): Promise<void> {
  let previous: string | null = after?.position ?? null;
  for (const body of bodies) {
    const position = keyBetween(previous, null);
    await insert("questions", { id: newId(), session_id: sessionId, body, position });
    previous = position;
  }
}

export async function renameQuestion(questionId: string, body: string): Promise<void> {
  await update("questions", questionId, { body });
}
