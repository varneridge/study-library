import { useEffect, useRef, useState } from "react";
import { closeShortcuts, dismissToast, useOverlays } from "../lib/ui";

const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  { group: "Anywhere", keys: [["Ctrl K", "Go to a module, week, reading or question"], ["/", "Search"], ["?", "These shortcuts"]] },
  { group: "On a week", keys: [["[", "Previous week"], ["]", "Next week"], ["Space, arrows, Space", "Pick up a focused reading and move it"]] },
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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shortcuts && !dialog.open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
    }
    if (!shortcuts && dialog.open) {
      dialog.close();
      triggerRef.current?.focus();
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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (ask && !dialog.open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setTyped("");
      dialog.showModal();
    }
    if (!ask && dialog.open) {
      dialog.close();
      triggerRef.current?.focus();
    }
  }, [ask]);

  const ready = !ask?.typed || typed.trim() === ask.typed;

  return (
    <dialog
      ref={ref}
      className="dialog"
      onCancel={(e) => { e.preventDefault(); ask?.resolve(false); }}
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
            <button type="button" className="quiet" onClick={() => ask.resolve(false)}>Cancel</button>
            <button className={`button ${ask.danger ? "danger" : "primary"}`} disabled={!ready} autoFocus={!ask.typed}>
              {ask.confirm}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

// The live region is always present, so screen readers announce each notice.
function ToastView() {
  const { toast } = useOverlays();
  return (
    <div className="toast-region" aria-live="polite">
      {toast && (
        <div className="toast" key={toast.id}>
          <span>{toast.message}</span>
          {toast.action && (
            <button className="link" onClick={() => { void toast.action!.run(); dismissToast(); }}>{toast.action.label}</button>
          )}
          <button className="quiet" aria-label="Dismiss" onClick={dismissToast}>×</button>
        </div>
      )}
    </div>
  );
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
