// Lets the parent app drive undo and redo in the embedded word processor. Only the
// parent window on the same origin is obeyed, so no other page can replay keystrokes,
// and each command is dispatched once on the canvas so a window listener sees it once.
(function () {
  const params = new URLSearchParams(window.location.search);
  if (params.get("noribbon") === "1" || params.get("host") === "parent") {
    document.documentElement.classList.add("no-ribbon");
  }
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const shortcuts = {
    "wordcraft:undo": { key: "z", code: "KeyZ", shiftKey: false },
    "wordcraft:redo": isMac ? { key: "Z", code: "KeyZ", shiftKey: true } : { key: "y", code: "KeyY", shiftKey: false },
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (window.parent === window || event.source !== window.parent) return;
    if (!event.data || typeof event.data !== "object") return;
    const shortcut = shortcuts[event.data.type];
    if (!shortcut) return;
    const target = document.getElementById("wordcraft_canvas") ?? window;
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: shortcut.key,
        code: shortcut.code,
        ctrlKey: !isMac,
        metaKey: isMac,
        shiftKey: shortcut.shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
})();
