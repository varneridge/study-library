// Lets the parent app drive undo, redo and save in the embedded word processor,
// keeps only the core writing tabs, and reports WordCraft's embedded chrome
// (the room it keeps for the parent's own controls, and its colours) so the
// parent can draw its controls in that room.
//
// Messages, all same-origin and only to or from the parent window:
//   parent -> here  wordcraft:undo | wordcraft:redo | wordcraft:save
//   parent -> here  wordcraft:chrome { tabInsetStart?, tabInsetEnd?, statusInsetStart? }
//   here -> parent  wordcraft:chrome { chrome: <ui.hostChrome result> | null }
// A null chrome means the build has no embedded chrome (an older WordCraft):
// the canvas then falls back to hiding the title bar by offset (index.html).
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var hosted = params.get("host") === "parent" && window.parent !== window;
  var wantsEmbedded = params.get("chrome") === "embedded";
  // An older parent asked for noribbon=1, which meant "hide the title bar by offset".
  if (params.get("noribbon") === "1" && !wantsEmbedded) {
    document.documentElement.classList.add("legacy-chrome");
  }

  // File is not listed: it is not a ribbon tab WordCraft lets anyone hide
  // (ribbon.rs builds it apart from the user's tabs); embedded chrome removes it.
  var HIDE_TABS = ["Draw", "Mailings", "Developer", "Zotero", "Help"];
  var CHROME_ATTEMPTS = 12;
  var CHROME_RETRY_MS = 250;
  var COLOUR_POLL_MS = 3000;

  function api() {
    var w = window.wordcraft;
    return w && typeof w.execute === "function" ? w : null;
  }

  function toParent(message) {
    if (!hosted) return;
    window.parent.postMessage(message, window.location.origin);
  }

  function applyRibbonCustomisation() {
    var wc = api();
    if (!wc) return;
    HIDE_TABS.forEach(function (tab) {
      try {
        wc.execute("tools.customizeRibbon", { hide: tab }).catch(function () {});
      } catch (e) {
        // A tab this build does not have is not an error.
      }
    });
  }

  // The last chrome sent, so a colour poll that finds nothing new sends nothing.
  var lastChrome = "";

  function reportChrome(result) {
    var chrome = result && result.embedded === true ? result : null;
    var text = JSON.stringify(chrome);
    if (text === lastChrome) return;
    lastChrome = text;
    toParent({ type: "wordcraft:chrome", chrome: chrome });
  }

  function legacy() {
    document.documentElement.classList.add("legacy-chrome");
    reportChrome(null);
  }

  // Ask for the chrome until the app answers. The command API is installed
  // before the app takes requests, so early calls can fail; an unknown-command
  // failure on every attempt means an older build.
  function probeChrome(attempt) {
    var wc = api();
    if (!wantsEmbedded) return;
    if (!wc) {
      if (attempt < CHROME_ATTEMPTS * 4) setTimeout(function () { probeChrome(attempt + 1); }, CHROME_RETRY_MS);
      else legacy();
      return;
    }
    wc.execute("ui.hostChrome", {}).then(
      function (result) {
        if (result && result.embedded === true) {
          reportChrome(result);
          startColourPoll();
        } else {
          // The build knows the command but was not embedded (not hosted, or no chrome param reached it).
          legacy();
        }
      },
      function () {
        legacy();
      }
    );
  }

  var pollTimer = null;
  function startColourPoll() {
    if (pollTimer !== null) return;
    // Dark mode or a theme change alters WordCraft's colours without telling
    // the page, so they are read again while the page is visible.
    pollTimer = setInterval(function () {
      if (document.visibilityState !== "visible") return;
      var wc = api();
      if (wc) wc.execute("ui.hostChrome", {}).then(reportChrome, function () {});
    }, COLOUR_POLL_MS);
  }

  var started = false;
  function start() {
    if (started) return;
    started = true;
    applyRibbonCustomisation();
    probeChrome(0);
  }

  // Wait briefly for window.wordcraft, then start once.
  var attempts = 0;
  var timer = setInterval(function () {
    attempts += 1;
    if (api()) {
      clearInterval(timer);
      start();
    } else if (attempts > 50) {
      clearInterval(timer);
      if (wantsEmbedded) legacy();
    }
  }, 200);

  window.addEventListener("TrunkApplicationStarted", function () {
    setTimeout(function () {
      if (api()) {
        clearInterval(timer);
        start();
      }
    }, 300);
  });

  function dispatchKey(key, ctrl, shift) {
    var target = document.getElementById("wordcraft_canvas") || document.body;
    var evt = new KeyboardEvent("keydown", {
      key: key,
      code: "Key" + key.toUpperCase(),
      ctrlKey: !!ctrl,
      metaKey: !!ctrl,
      shiftKey: !!shift,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(evt);
  }

  function run(command, key) {
    var wc = api();
    if (wc) wc.execute(command).catch(function () { dispatchKey(key, true, false); });
    else dispatchKey(key, true, false);
  }

  function finite(v) {
    return typeof v === "number" && isFinite(v) ? v : undefined;
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin) return;
    if (window.parent === window || event.source !== window.parent) return;
    if (!event.data || typeof event.data !== "object") return;

    switch (event.data.type) {
      case "wordcraft:undo":
        run("edit.undo", "z");
        return;
      case "wordcraft:redo":
        run("edit.redo", "y");
        return;
      case "wordcraft:save":
        run("file.save", "s");
        return;
      case "wordcraft:chrome": {
        var wc = api();
        if (!wc || !wantsEmbedded) return;
        var p = {};
        var a = finite(event.data.tabInsetStart);
        var b = finite(event.data.tabInsetEnd);
        var c = finite(event.data.statusInsetStart);
        if (a !== undefined) p.tabInsetStart = a;
        if (b !== undefined) p.tabInsetEnd = b;
        if (c !== undefined) p.statusInsetStart = c;
        wc.execute("ui.hostChrome", p).then(reportChrome, function () {});
        return;
      }
    }
  });
})();
