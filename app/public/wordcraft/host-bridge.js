// Lets the parent app drive undo, redo, and save in the embedded word processor,
// and customises the ribbon tabs to keep only core writing tools.
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get("noribbon") === "1" || params.get("host") === "parent") {
    document.documentElement.classList.add("no-ribbon");
  }

  function applyRibbonCustomisation() {
    if (!window.wordcraft || typeof window.wordcraft.execute !== "function") return;
    const hideTabs = ["File", "Draw", "Mailings", "Developer", "Zotero", "Help"];
    for (const tab of hideTabs) {
      try {
        window.wordcraft.execute("tools.customizeRibbon", { hide: tab }).catch(() => {});
      } catch {
        // Ignore unsupported tab names gracefully
      }
    }
  }

  // Poll briefly for window.wordcraft on startup to hide unwanted tabs
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (window.wordcraft && typeof window.wordcraft.execute === "function") {
      clearInterval(timer);
      applyRibbonCustomisation();
    } else if (attempts > 50) {
      clearInterval(timer);
    }
  }, 200);

  window.addEventListener("TrunkApplicationStarted", () => {
    setTimeout(applyRibbonCustomisation, 300);
  });

  function dispatchKey(key, ctrl, shift) {
    const target = document.getElementById("wordcraft_canvas") || document.body;
    const evt = new KeyboardEvent("keydown", {
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

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (window.parent === window || event.source !== window.parent) return;
    if (!event.data || typeof event.data !== "object") return;

    const hasWordcraft = window.wordcraft && typeof window.wordcraft.execute === "function";

    switch (event.data.type) {
      case "wordcraft:undo":
        if (hasWordcraft) {
          window.wordcraft.execute("edit.undo").catch(() => dispatchKey("z", true, false));
        } else {
          dispatchKey("z", true, false);
        }
        return;
      case "wordcraft:redo":
        if (hasWordcraft) {
          window.wordcraft.execute("edit.redo").catch(() => dispatchKey("y", true, false));
        } else {
          dispatchKey("y", true, false);
        }
        return;
      case "wordcraft:save":
        if (hasWordcraft) {
          window.wordcraft.execute("file.save").catch(() => dispatchKey("s", true, false));
        } else {
          dispatchKey("s", true, false);
        }
        return;
    }
  });
})();
