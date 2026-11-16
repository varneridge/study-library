import assert from "node:assert/strict";
import { availableUpdate, dismiss, isDismissed, isNewer, RELEASES_PAGE, updateHref } from "../src/lib/update";

function mockFetch(body: unknown, ok = true) {
  return (async () => ({ ok, status: ok ? 200 : 403, json: async () => body })) as unknown as typeof fetch;
}

function mockStorage() {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) };
}

export async function runUpdateTests() {
  // isNewer
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("v2.0.0", "1.99.99"), true);
  assert.equal(isNewer("1.3.0", "1.3.0"), false);
  assert.equal(isNewer("1.2.9", "1.3.0"), false);
  assert.equal(isNewer("nightly", "1.0.0"), false);
  assert.equal(isNewer("2.0.0-beta", "1.0.0"), false);
  assert.equal(isNewer("2.0.0", "dev"), false);

  // availableUpdate
  const update1 = await availableUpdate(mockFetch({ tag_name: "v1.4.0" }), "1.3.0");
  assert.deepEqual(update1, { version: "1.4.0" });

  const update2 = await availableUpdate(mockFetch({ tag_name: "v1.3.0" }), "1.3.0");
  assert.equal(update2, null);

  const update3 = await availableUpdate(mockFetch({ tag_name: "nightly" }), "1.3.0");
  assert.equal(update3, null);

  await assert.rejects(async () => {
    await availableUpdate(mockFetch({}, false), "1.3.0");
  }, /403/);

  // dismiss & isDismissed
  const store = mockStorage();
  assert.equal(isDismissed("1.4.0", store), false);
  dismiss("1.4.0", store);
  assert.equal(isDismissed("1.4.0", store), true);
  assert.equal(isDismissed("1.5.0", store), false);

  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => dismiss("1.4.0", blocked));
  assert.equal(isDismissed("1.4.0", blocked), false);

  // updateHref
  assert.equal(
    updateHref({ version: "1.4.0" }, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
    "studylibrary://update?version=1.4.0"
  );
  assert.equal(
    updateHref({ version: "1.4.0" }, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"),
    RELEASES_PAGE
  );
  console.log("ok   in-app update logic and links");
}
