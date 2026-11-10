// Lets the parent app drive undo, redo and save in the embedded word processor,
// keeps only the core writing tabs, stops WordCraft's File features from
// running, and reports WordCraft's embedded chrome (the room it keeps for the
// parent's own controls, and its colours) so the parent can draw its controls
// in that room.
//
// Messages, all same-origin and only to or from the parent window:
//   parent -> here  wordcraft:undo | wordcraft:redo | wordcraft:save
//   parent -> here  wordcraft:chrome { tabInsetStart?, tabInsetEnd?, statusInsetStart? }
//   here -> parent  wordcraft:chrome { chrome: <ui.hostChrome result> | null }
// A null chrome means the build has no embedded chrome (an older WordCraft),
// so the canvas keeps its title bar lifted out of view (index.html) and the
// File guard below stays on.
//
// URL parameters read here: host=parent, chrome=embedded, noribbon=1 (an older
// parent) and fileGuard=<width>,<height>, the File tab rectangle in CSS pixels
// that the parent covers with its Back button.
(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var hosted = params.get("host") === "parent" && window.parent !== window;
  var wantsEmbedded = params.get("chrome") === "embedded";
  var root = document.documentElement;

  // A hosted editor starts with the title bar lifted, because the deployed
  // build has no embedded chrome and lifting it only after the probe failed
  // made the whole canvas jump by 38px once it had drawn. A build that
  // confirms embedded chrome has no title bar, so the class is removed then.
  // An older parent asked for noribbon=1, which meant the same lift.
  if ((hosted && wantsEmbedded) || (params.get("noribbon") === "1" && !wantsEmbedded)) {
    root.classList.add("legacy-chrome");
  }

  // File is not listed: it is not a ribbon tab WordCraft lets anyone hide
  // (ribbon.rs builds it apart from the user's tabs), so the File guard below
  // disables it instead, while embedded chrome removes it altogether.
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

  // ---- File guard ---------------------------------------------------------
  //
  // The parent draws its Back button over the File tab, which already keeps
  // the pointer away from it; this guard is the second line, so that a touch
  // which slips past the parent, or a click before the parent has drawn,
  // still never opens Backstage. It runs in the capture phase on window,
  // which comes before every listener eframe adds to the canvas or document,
  // and it is installed before the wasm module starts because module scripts
  // wait for this classic script to finish.

  function parseGuard(text) {
    var parts = String(text || "").split(",");
    var w = Number(parts[0]);
    var h = Number(parts[1]);
    return {
      width: isFinite(w) && w > 0 ? w : 68,
      height: isFinite(h) && h > 0 ? h : 30,
    };
  }

  var guard = parseGuard(params.get("fileGuard"));

  // The File tab exists only in a build without embedded chrome, which is
  // exactly when the title bar is lifted and the tab sits at the top left.
  function pointerGuardActive() {
    return hosted && root.classList.contains("legacy-chrome");
  }

  function inFileTab(x, y) {
    return x >= 0 && y >= 0 && x < guard.width && y < guard.height;
  }

  function eventPoint(e) {
    var t = e.changedTouches && e.changedTouches[0];
    return t ? { x: t.clientX, y: t.clientY } : { x: e.clientX, y: e.clientY };
  }

  function swallow(e) {
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }

  // A press that began on the File tab is followed by its moves and its
  // release, so WordCraft sees none of it; a press that began elsewhere is
  // left whole, even if it ends over the tab, so no drag is left half open.
  var FAMILY = {
    pointerdown: "pointer", pointermove: "pointer", pointerup: "pointer", pointercancel: "pointer",
    mousedown: "mouse", mousemove: "mouse", mouseup: "mouse",
    touchstart: "touch", touchmove: "touch", touchend: "touch", touchcancel: "touch",
  };
  var STARTS = { pointerdown: true, mousedown: true, touchstart: true };
  var ENDS = { pointerup: true, pointercancel: true, mouseup: true, touchend: true, touchcancel: true };
  var held = { pointer: false, mouse: false, touch: false };

  function onPointerish(e) {
    var family = FAMILY[e.type];
    if (STARTS[e.type]) {
      if (!pointerGuardActive()) return;
      var p = eventPoint(e);
      if (!inFileTab(p.x, p.y)) return;
      held[family] = true;
      swallow(e);
      return;
    }
    if (!held[family]) return;
    if (ENDS[e.type]) held[family] = false;
    swallow(e);
  }

  // Clicks carry no press of their own, so they are judged by where they land.
  function onClickish(e) {
    if (!pointerGuardActive()) return;
    var p = eventPoint(e);
    if (inFileTab(p.x, p.y)) swallow(e);
  }

  if (hosted) {
    Object.keys(FAMILY).forEach(function (type) {
      window.addEventListener(type, onPointerish, { capture: true, passive: false });
    });
    ["click", "dblclick", "auxclick", "contextmenu"].forEach(function (type) {
      window.addEventListener(type, onClickish, { capture: true, passive: false });
    });
  }

  // The shortcuts that reach File without the tab: Alt+F opens it, and New,
  // Open and Save As would replace or fork the essay that autosave keeps, so
  // none of them reaches WordCraft while it is hosted. AltGr reports both Ctrl
  // and Alt, which is why each test requires the other modifier to be absent.
  function isFileShortcut(e) {
    var key = (e.key || "").toLowerCase();
    var code = e.code || "";
    var mod = e.ctrlKey || e.metaKey;
    if (e.altKey && !mod && (key === "f" || code === "KeyF")) return true;
    if (!mod || e.altKey) return false;
    if (!e.shiftKey && (key === "o" || code === "KeyO" || key === "n" || code === "KeyN")) return true;
    return e.shiftKey && (key === "s" || code === "KeyS");
  }

  if (hosted) {
    window.addEventListener(
      "keydown",
      function (e) {
        if (isFileShortcut(e)) swallow(e);
      },
      true
    );
  }

  // ---- Ribbon and chrome --------------------------------------------------

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
    // The lift follows the report, because only a build without embedded
    // chrome still draws the title bar that the lift hides.
    root.classList.toggle("legacy-chrome", chrome === null);
    var text = JSON.stringify(chrome);
    if (text === lastChrome) return;
    lastChrome = text;
    toParent({ type: "wordcraft:chrome", chrome: chrome });
  }

  function legacy() {
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

  // ---- Commands from the parent -------------------------------------------

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
