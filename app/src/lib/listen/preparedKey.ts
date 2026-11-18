// The name of a paragraph's prepared audio, shared by the reader, the Worker
// and the audio preparation worker's uploads.
//
// Prepared audio is stored by content: the key is a hash of what is said, by
// which voice, under which version of the pronunciation rules. The same
// paragraph in two readings shares one file, a reading that changes only
// prepares the paragraphs that changed, and a change to the rules (a new
// PRONUNCIATION_VERSION) makes every paragraph ask for fresh audio. Used by
// both the app and the Worker, so it needs nothing but Web Crypto.

import { PRONUNCIATION_VERSION } from "./spokenText";

/** Identifies the model whose voice prepared audio carries. */
export const PREPARED_MODEL = "kokoro-82m-v1.0";

export async function preparedAudioKey(voice: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${PREPARED_MODEL}\n${PRONUNCIATION_VERSION}\n${voice}\n${text}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.subarray(0, 20), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether a string is shaped like a prepared audio key, before it is used in an R2 key. */
export function isPreparedAudioKey(key: string): boolean {
  return /^[0-9a-f]{40}$/.test(key);
}
