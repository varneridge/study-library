// filename: app/tests/highlight-comments.regression.ts
// Regression test: a comment writer must keep working after dispose().
// Reader.tsx memoises its writer and disposes it in an effect cleanup. React's
// StrictMode (main.tsx) runs that cleanup and then the effect again on the same
// writer, so a writer that refused drafts after dispose() silently lost every
// comment typed in a highlight card during development and in the e2e suite.
// Run with: npx tsx tests/highlight-comments.regression.ts
import assert from "node:assert/strict";
import { commentWriter } from "../src/lib/highlightComments";

let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${(err as Error).message}`);
  }
}

await test("a comment typed after a StrictMode cleanup is still written", async () => {
  const writes: Array<[string, string | null]> = [];
  const writer = commentWriter(async (id, c) => void writes.push([id, c]), 10);
  // StrictMode: mount, cleanup, mount again with the same memoised writer.
  await writer.dispose();
  writer.set("h1", "Typed after the reader opened.");
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(writes, [["h1", "Typed after the reader opened."]]);
});

await test("dispose writes what is pending at once and cancels its timer", async () => {
  const writes: Array<[string, string | null]> = [];
  const writer = commentWriter(async (id, c) => void writes.push([id, c]), 10_000);
  writer.set("h1", "pending");
  await writer.dispose();
  assert.deepEqual(writes, [["h1", "pending"]]);
  assert.equal(writer.pending("h1"), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writes.length, 1, "the cancelled timer must not write a second time");
});

await test("blur after a cleanup still saves, so the failure toast path stays meaningful", async () => {
  const writes: string[] = [];
  const writer = commentWriter(async (_id, c) => void writes.push(String(c)), 10_000);
  await writer.dispose();
  writer.set("h2", "draft");
  await writer.flush("h2");
  assert.deepEqual(writes, ["draft"]);
});

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all 3 passed");
