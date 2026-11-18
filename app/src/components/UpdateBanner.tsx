import { useEffect, useState } from "react";
import {
  availableUpdate, dismiss, isDismissed, UPDATE_RETRY_MS, updateHref, updatesInPlace, updateStartingText, type Release,
} from "../lib/update";

export function UpdateBanner() {
  const [release, setRelease] = useState<Release | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let live = true;
    availableUpdate().then(
      (found) => live && found && !isDismissed(found.version) && setRelease(found),
      () => undefined, // unreachable GitHub never interrupts anyone
    );
    return () => {
      live = false;
    };
  }, []);

  // A refused update leaves the app running, so the button comes back once the
  // app has had time to close; a successful one closes this window first.
  useEffect(() => {
    if (!starting) return undefined;
    const timer = setTimeout(() => setStarting(false), UPDATE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [starting]);

  if (!release) return null;
  const later = () => {
    dismiss(release.version);
    setRelease(null);
  };
  // The banner changes on the next tick, because a link that is removed from the
  // page during its own click is never followed, and the update would not start.
  const start = () => {
    if (updatesInPlace()) setTimeout(() => setStarting(true), 0);
  };

  return (
    <aside
      role="status"
      className="update-banner"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "0.75rem",
        alignItems: "center",
        justifyContent: "center",
        padding: "0.4rem 1rem",
        fontSize: "var(--fs-sm, 0.875rem)",
        background: "var(--card-bg, #f6f5f3)",
        borderBottom: "1px solid var(--line, rgba(0, 0, 0, 0.1))",
        color: "var(--ink, #1c1917)",
      }}
    >
      {starting ? (
        <span>{updateStartingText(release.version)}</span>
      ) : (
        <>
          <span>Study Library {release.version} is available.</span>
          <a href={updateHref(release)} onClick={start} className="button primary small" style={{ textDecoration: "none" }}>
            Update now
          </a>
          <button type="button" className="button quiet small" onClick={later}>
            Later
          </button>
        </>
      )}
    </aside>
  );
}
