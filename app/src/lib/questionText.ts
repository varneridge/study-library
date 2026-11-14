// Turning typed or pasted text into seminar questions. Kept free of storage
// so it can be tested on its own.

// A pasted list becomes one question per line, without its numbering or
// bullets, so "1. Why did Rome fall?" and "- Why did Rome fall?" both read
// "Why did Rome fall?". Blank lines are skipped.
export function splitQuestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\(?\d+[.)]|\(?[a-z][.)]|[-*\u2022])\s+/i, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
