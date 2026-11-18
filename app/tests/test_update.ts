import assert from "node:assert/strict";
import {
  availableUpdate, dismiss, INSTALLER_DOWNLOAD_URL, INSTALLER_FILE_NAME, isDismissed, isNewer, openInDesktopHref,
  RELEASES_PAGE, UPDATE_RETRY_MS, updateHref, updatesInPlace, updateStartingText,
} from "../src/lib/update";
import type { SyncState } from "../src/lib/sync";
import { syncStatus, syncView } from "../src/lib/syncStatus";
import { detectDesktop } from "../src/lib/shell";
import {
  activate, activeTab, closeTab, followRoute, HOME_HREF, HOME_TAB_ID, initialTabs, MAX_CLOSED, MAX_MOUNTED,
  mountedTabIds, openTab, reopenTab, restoreTabs,
} from "../src/lib/tabs";

function mockFetch(body: unknown, ok = true, status = ok ? 200 : 403) {
  return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
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

  const update4 = await availableUpdate(mockFetch({}, false, 404), "1.3.0");
  assert.equal(update4, null);

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
  // The download link names the installer itself, so a press saves the .exe
  // rather than opening GitHub, and the open link carries the whole address.
  assert.equal(INSTALLER_FILE_NAME, "StudyLibrarySetup.exe");
  assert.equal(INSTALLER_DOWNLOAD_URL, "https://github.com/varneridge/study-library/releases/latest/download/StudyLibrarySetup.exe");
  assert.ok(INSTALLER_DOWNLOAD_URL.endsWith(`/${INSTALLER_FILE_NAME}`));
  assert.equal(openInDesktopHref("/"), "studylibrary://open?path=%2F");
  assert.equal(openInDesktopHref("/?v=reader&id=r1&page=3"), "studylibrary://open?path=%2F%3Fv%3Dreader%26id%3Dr1%26page%3D3");
  const awkward = "/?v=search&q=a b#x";
  assert.equal(new URL(openInDesktopHref(awkward)).searchParams.get("path"), awkward, "the address survives whole, query and fragment included");

  // Update now installs in place only where the Windows app answers the link,
  // and the banner then says what will happen instead of offering the button again.
  assert.equal(updatesInPlace("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), true);
  assert.equal(updatesInPlace("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), false);
  const starting = updateStartingText("1.4.0");
  assert.ok(starting.includes("1.4.0") && starting.includes("reopen"), starting);
  assert.ok(!/[\u2013\u2014]/.test(starting), "no en or em dashes in update words");
  assert.ok(UPDATE_RETRY_MS >= 60_000, "the button comes back only once the app has had time to close");
  console.log("ok   in-app update logic and links");

  // syncStatus: every state is switched on at once, and each is then cleared
  // in turn, so each step shows which state the one above it was hiding.
  const quiet: SyncState = { online: true, busy: false, pulling: false, paused: false, pending: 0, error: null, expired: false };
  let all: SyncState = { online: false, busy: true, pulling: true, paused: true, pending: 3, error: "push failed", expired: true };
  const steps: [Partial<SyncState>, string][] = [
    [{}, "expired"],
    [{ expired: false }, "paused"],
    [{ paused: false }, "offline"],
    [{ online: true }, "error"],
    [{ error: null }, "syncing"],
    [{ busy: false }, "syncing"],
    [{ pulling: false }, "pending"],
    [{ pending: 0 }, "synced"],
  ];
  for (const [change, expected] of steps) {
    all = { ...all, ...change };
    assert.equal(syncStatus(all), expected, JSON.stringify(change));
  }
  assert.equal(syncStatus({ ...quiet, pulling: true }), "syncing", "a pull alone counts as syncing");
  assert.equal(syncStatus({ ...quiet, busy: true, pending: 4 }), "syncing", "a push under way outranks what waits");

  // syncView: each status has its own symbol, only syncing spins, and the
  // words count what waits.
  const icons = {
    expired: syncView({ ...quiet, expired: true }).icon,
    paused: syncView({ ...quiet, paused: true }).icon,
    offline: syncView({ ...quiet, online: false }).icon,
    error: syncView({ ...quiet, error: "x" }).icon,
    syncing: syncView({ ...quiet, busy: true }).icon,
    pending: syncView({ ...quiet, pending: 1 }).icon,
    synced: syncView(quiet).icon,
  };
  assert.deepEqual(icons, {
    expired: "warning", paused: "syncPaused", offline: "syncOffline", error: "warning",
    syncing: "syncSpin", pending: "syncPending", synced: "syncDone",
  });
  assert.equal(syncView({ ...quiet, busy: true }).spinning, true);
  assert.equal(syncView({ ...quiet, pending: 2 }).spinning, false);
  assert.equal(syncView({ ...quiet, expired: true }).problem, true);
  assert.equal(syncView({ ...quiet, error: "x" }).problem, true);
  assert.equal(syncView({ ...quiet, online: false }).problem, false);
  assert.equal(syncView({ ...quiet, pending: 1 }).label, "1 change is saved on this device and will be sent in a moment.");
  assert.equal(syncView({ ...quiet, pending: 3 }).label, "3 changes are saved on this device and will be sent in a moment.");
  assert.ok(syncView({ ...quiet, online: false, pending: 2 }).label.includes("2 changes will wait"));
  assert.ok(!syncView({ ...quiet, online: false }).label.includes("0 changes"));
  for (const view of [quiet, { ...quiet, expired: true }, { ...quiet, error: "x", pending: 5 }].map(syncView)) {
    assert.ok(!/[\u2013\u2014]/.test(view.label), "no en or em dashes in sync words");
  }
  console.log("ok   sync status precedence, symbols and words");

  // The desktop window is known by its address mark, by a shell's user agent,
  // or by the mark kept for the window's session after a reload.
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Edg/131.0";
  assert.equal(detectDesktop(`${edge} SLDesktop/1`, "", false), true);
  assert.equal(detectDesktop(edge, "?sl=desktop&v=home", false), true);
  assert.equal(detectDesktop(edge, "?v=home", true), true, "a reload keeps the mark for the window");
  assert.equal(detectDesktop(edge, "?v=home", false), false);
  assert.equal(detectDesktop(`${edge} SLDesktopish`, "?sl=web", false), false);

  // Tabs: Home is pinned and stays, new tabs open in front or behind, and
  // only the tab in front follows the route.
  const home = initialTabs("/");
  assert.equal(activeTab(home).id, HOME_TAB_ID);
  assert.equal(activeTab(home).pinned, true);
  assert.equal(closeTab(home, HOME_TAB_ID), home, "the Home tab cannot be closed");
  assert.equal(reopenTab(home), home, "with nothing closed there is nothing to reopen");

  // Home stays on the home page, so a move away from it opens a fresh tab in
  // front and leaves Home where it was, and a window opened elsewhere does the same.
  assert.equal(HOME_HREF, "/");
  assert.equal(followRoute(home, "/"), home, "Home at the home page is already where it belongs");
  const fromHome = followRoute(home, "/?v=module&id=m1");
  assert.equal(fromHome.tabs[0].href, HOME_HREF, "Home keeps the home page");
  assert.equal(activeTab(fromHome).href, "/?v=module&id=m1", "the fresh tab comes to the front");
  assert.equal(activeTab(fromHome).id, "t1");
  assert.equal(activeTab(activate(fromHome, HOME_TAB_ID)).href, HOME_HREF, "pressing Home always shows the home page");
  const deepStart = initialTabs("/?v=week&id=w1");
  assert.equal(deepStart.tabs[0].href, HOME_HREF);
  assert.equal(activeTab(deepStart).href, "/?v=week&id=w1");
  const oldSave = JSON.stringify({ tabs: [{ id: HOME_TAB_ID, href: "/?v=settings" }, { id: "t4", href: "/?v=search" }], activeId: "t4" });
  assert.equal(restoreTabs(oldSave, "/?v=search").tabs[0].href, HOME_HREF, "an older save that moved Home is put right");

  let tabs = openTab(home, "/?v=reader&id=r1");
  assert.equal(activeTab(tabs).href, "/?v=reader&id=r1");
  tabs = openTab(tabs, "/?v=week&id=w1", true);
  assert.equal(activeTab(tabs).href, "/?v=reader&id=r1", "a background tab leaves the front one in front");
  assert.deepEqual(mountedTabIds(tabs), ["t1", HOME_TAB_ID], "a background tab is not mounted until it is shown");
  assert.equal(activate(tabs, "missing"), tabs);
  assert.equal(activate(tabs, "t1"), tabs, "the tab in front is already active");
  tabs = followRoute(tabs, "/?v=reader&id=r1&page=3");
  assert.equal(activeTab(tabs).href, "/?v=reader&id=r1&page=3");
  assert.equal(tabs.tabs[0].href, "/", "a tab behind keeps its own address");
  assert.equal(followRoute(tabs, "/?v=reader&id=r1&page=3"), tabs);

  // Closing brings the right-hand neighbour forward, or the left one at the
  // end, and a closed tab comes back with a new id at the address it had.
  const closed = closeTab(tabs, "t1");
  assert.equal(closed.activeId, "t2", "the tab to the right comes forward");
  assert.deepEqual(closed.closed, ["/?v=reader&id=r1&page=3"]);
  assert.equal(closeTab(closed, "t2").activeId, HOME_TAB_ID, "the last tab hands over to its left");
  assert.equal(closeTab(tabs, "t2").activeId, "t1", "closing a tab behind leaves the front one alone");
  const reopened = reopenTab(closed);
  assert.equal(activeTab(reopened).href, "/?v=reader&id=r1&page=3");
  assert.equal(activeTab(reopened).id, "t3", "a reopened tab never reuses an id");
  assert.deepEqual(reopened.closed, []);

  let many = home;
  for (let i = 0; i < MAX_CLOSED + 5; i += 1) {
    const opened = openTab(many, `/?v=week&id=w${i}`);
    many = closeTab(opened, opened.activeId);
  }
  assert.equal(many.closed.length, MAX_CLOSED, "only the most recent closed tabs are kept");
  assert.equal(many.closed[0], "/?v=week&id=w5");
  assert.equal(many.closed[MAX_CLOSED - 1], `/?v=week&id=w${MAX_CLOSED + 4}`);
  assert.equal(many.tabs.length, 1);

  let lots = home;
  for (let i = 0; i < MAX_MOUNTED + 2; i += 1) lots = openTab(lots, `/?v=module&id=m${i}`);
  const mounted = mountedTabIds(lots);
  assert.equal(mounted.length, MAX_MOUNTED);
  assert.equal(mounted[0], lots.activeId);
  assert.ok(!mounted.includes(HOME_TAB_ID), "the tab longest out of view is let go first");
  assert.equal(mountedTabIds(activate(lots, HOME_TAB_ID))[0], HOME_TAB_ID);

  // A reload brings the tabs back as they were, and anything broken starts again from Home.
  const saved = JSON.stringify(reopened);
  assert.deepEqual(restoreTabs(saved, "/?v=reader&id=r1&page=3"), reopened, "the tabs survive a reload");
  assert.equal(activeTab(restoreTabs(saved, "/?v=settings")).href, "/?v=settings", "the tab in front follows the reloaded address");
  assert.deepEqual(restoreTabs("not json", "/x"), initialTabs("/x"));
  assert.deepEqual(restoreTabs(null, "/"), initialTabs("/"));
  assert.deepEqual(restoreTabs(JSON.stringify({ tabs: [{ id: "t1", href: "/" }] }), "/"), initialTabs("/"), "without Home it starts again");
  const later = restoreTabs(JSON.stringify({ tabs: [{ id: HOME_TAB_ID, href: "/" }, { id: "t9", href: "/?v=search" }], activeId: "t9" }), "/?v=search");
  assert.equal(openTab(later, "/").activeId, "t10", "ids are never reused after a reload");
  console.log("ok   desktop detection and tab rules");
}
