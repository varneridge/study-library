import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { closeShortcuts, dismissToast, useCloseOnBack, useOverlays } from "../lib/ui";
import { Icon } from "./icons";

const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  { group: "Anywhere", keys: [["Ctrl K", "Go to a module, week, reading or question"], ["/", "Search"], ["?", "These shortcuts"]] },
  { group: "On a week", keys: [["[", "Previous week"], ["]", "Next week"]] },
  { group: "In the job search", keys: [["N", "Add an application"], ["/", "Find an application"], ["Esc", "Clear the search"]] },
  {
    group: "Reading",
    keys: [
      ["Ctrl F or /", "Find in the reading"], ["Enter", "Next match"], ["Shift Enter", "Previous match"],
      ["← →", "Previous and next page"], ["+ −", "Zoom in and out"], ["0", "Fit to width"],
      ["H", "Highlight as you select"], ["Esc", "Close find, or stop highlighting"],
    ],
  },
];

function Shortcuts() {
  const { shortcuts } = useOverlays();
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useCloseOnBack(shortcuts, closeShortcuts);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shortcuts && !dialog.open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    }
    if (!shortcuts && dialog.open) {
      dialog.close();
      const trigger = triggerRef.current;
      setTimeout(() => {
        trigger?.focus();
      }, 50);
    }
  }, [shortcuts]);
  return (
    <dialog ref={ref} className="dialog shortcuts" onCancel={(e) => { e.preventDefault(); closeShortcuts(); }} onClick={(e) => { if (e.target === e.currentTarget) closeShortcuts(); }}>
      <h2>Keyboard shortcuts</h2>
      {SHORTCUTS.map((g) => (
        <section key={g.group}>
          <p className="panel-label">{g.group}</p>
          <dl>
            {g.keys.map(([k, what]) => (
              <div key={k}><dt><kbd>{k}</kbd></dt><dd>{what}</dd></div>
            ))}
          </dl>
        </section>
      ))}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
        <button className="button" onClick={closeShortcuts}>Close</button>
      </div>
    </dialog>
  );
}

function Dialog() {
  const { ask } = useOverlays();
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [typed, setTyped] = useState("");

  useCloseOnBack(Boolean(ask), () => ask?.resolve(false));

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (ask && !dialog.open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setTyped("");
      dialog.showModal();
      requestAnimationFrame(() => {
        if (!dialog.open) return;
        if (ask.typed) {
          dialog.querySelector<HTMLInputElement>("input")?.focus();
        } else if (ask.danger) {
          dialog.querySelector<HTMLButtonElement>("[data-role=cancel]")?.focus();
        } else {
          dialog.querySelector<HTMLButtonElement>("[data-role=confirm]")?.focus();
        }
      });
    }
    if (!ask && dialog.open) {
      dialog.close();
      const trigger = triggerRef.current;
      setTimeout(() => {
        trigger?.focus();
      }, 50);
    }
  }, [ask]);

  const ready = !ask?.typed || typed.trim() === ask.typed;

  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => { e.preventDefault(); ask?.resolve(false); }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
          ask?.resolve(false);
        }
      }}
    >
      {ask && (
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); if (ready) ask.resolve(true); }}>
          <h2>{ask.title}</h2>
          {ask.body && <p className="small">{ask.body}</p>}
          {ask.typed && (
            <label className="field">
              <span>Type {ask.typed} to confirm</span>
              <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}
          <div className="row" style={{ justifyContent: "flex-end", marginTop: "1.25rem" }}>
            <button
              type="button"
              data-role="cancel"
              className="quiet"
              onClick={() => ask.resolve(false)}
            >
              Cancel
            </button>
            <button
              data-role="confirm"
              className={`button ${ask.danger ? "danger" : "primary"}`}
              disabled={!ready}
            >
              {ask.confirm}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

// The live region is always present, so screen readers announce each notice.
// If a modal dialog is open, the toast portals into the topmost open dialog so it stays interactive in the top layer.
export function ToastView() {
  const { toast } = useOverlays();
  const [target, setTarget] = useState<HTMLDialogElement | null>(null);

  useLayoutEffect(() => {
    const updateTarget = () => {
      const dialogs = typeof document !== "undefined"
        ? Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]"))
        : [];
      setTarget(dialogs.length > 0 ? dialogs[dialogs.length - 1] : null);
    };

    updateTarget();

    const observer = new MutationObserver(updateTarget);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });

    return () => observer.disconnect();
  }, [toast]);

  if (!toast) return null;

  const content = (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.action && (
        <button className="link" onClick={() => { void toast.action!.run(); dismissToast(); }}>
          {toast.action.label}
        </button>
      )}
      <button className="quiet" aria-label="Dismiss" onClick={() => dismissToast()}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );

  return target && target.isConnected ? createPortal(content, target) : content;
}

export function Overlays() {
  return (
    <>
      <Dialog />
      <Shortcuts />
      <ToastView />
    </>
  );
}
