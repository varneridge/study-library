// Remembers whether a seminar question's answer is open or folded away on this device.
// Stored in localStorage so it stays as left; defaults to open so questions are ready
// to answer.

export const questionKey = (id: string) => `question-open-${id}`;

export function readQuestionOpen(questionId: string): boolean {
  try {
    const val = localStorage.getItem(questionKey(questionId));
    if (val === "false") return false;
    return true;
  } catch {
    return true;
  }
}

export function writeQuestionOpen(questionId: string, open: boolean): void {
  try {
    localStorage.setItem(questionKey(questionId), open ? "true" : "false");
  } catch {
    // Ignore in private browsing
  }
}

// A one-line summary of an answer shown beside a folded question.
export function answerPreview(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.4 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[,;:.!?]+$/, "") + "\u2026";
}
