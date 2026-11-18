// The desktop app's update check compares the version that is installed, not the version of the page it shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { availableUpdate, currentVersion, installedVersion, SPEECH_HEALTH_URL, type DesktopApi } from "../src/lib/update";

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const github = (tag: string) => (async () => answer(200, { tag_name: tag })) as unknown as typeof fetch;
const health = (body: unknown, seen: string[] = []) =>
  (async (url: string) => {
    seen.push(url);
    return answer(200, body);
  }) as unknown as typeof fetch;
const offline = (async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;
const frameless = (version: unknown): DesktopApi => ({ app_version: async () => version });

test("a browser reports the page's own version without asking the desktop app", async () => {
  const seen: string[] = [];
  assert.equal(await installedVersion(false, frameless("0.1.0"), health({ appVersion: "0.1.0" }, seen)), currentVersion);
  assert.deepEqual(seen, []);
});

test("the frameless window's answer comes first and is read as x.y.z", async () => {
  const seen: string[] = [];
  assert.equal(await installedVersion(true, frameless("v0.53.8"), health({ appVersion: "0.40.0" }, seen)), "0.53.8");
  assert.deepEqual(seen, []);
});

test("the speech server answers when the window has no pywebview API", async () => {
  const seen: string[] = [];
  assert.equal(await installedVersion(true, undefined, health({ ok: true, appVersion: "0.53.8" }, seen)), "0.53.8");
  assert.deepEqual(seen, [SPEECH_HEALTH_URL]);
});

test("the speech server answers when the window's answer is unusable or fails", async () => {
  const failing: DesktopApi = { app_version: async () => Promise.reject(new Error("no window")) };
  assert.equal(await installedVersion(true, frameless(null), health({ appVersion: "0.53.8" })), "0.53.8");
  assert.equal(await installedVersion(true, failing, health({ appVersion: "0.53.8" })), "0.53.8");
});

test("the page's version stands in when neither the window nor the speech server can say", async () => {
  assert.equal(await installedVersion(true, undefined, offline), currentVersion);
  assert.equal(await installedVersion(true, frameless("not a version"), health({ appVersion: null })), currentVersion);
  assert.equal(await installedVersion(true, undefined, (async () => answer(500, {})) as unknown as typeof fetch), currentVersion);
});

test("an installed 0.53.8 is offered 0.54.0 even though the page is already 0.54.0", async () => {
  const installed = await installedVersion(true, frameless("0.53.8"), offline);
  assert.deepEqual(await availableUpdate(github("v0.54.0"), installed), { version: "0.54.0" });
  assert.equal(await availableUpdate(github("v0.54.0"), "0.54.0"), null);
});

test("an installed version that matches or passes the release is current", async () => {
  assert.equal(await availableUpdate(github("v0.54.0"), await installedVersion(true, frameless("0.54.0"), offline)), null);
  assert.equal(await availableUpdate(github("v0.54.0"), await installedVersion(true, frameless("0.55.1"), offline)), null);
});

test("without a version given, the check compares the installed one, which in a browser is the page's", async () => {
  assert.equal(await availableUpdate(github(`v${currentVersion}`)), null);
});
