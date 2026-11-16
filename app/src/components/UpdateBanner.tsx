import { useEffect, useState } from "react";
import { availableUpdate, dismiss, isDismissed, updateHref, type Release } from "../lib/update";

export function UpdateBanner() {
  const [release, setRelease] = useState<Release | null>(null);

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

  if (!release) return null;
  const later = () => {
    dismiss(release.version);
    setRelease(null);
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
      <span>Study Library {release.version} is available.</span>
      <a href={updateHref(release)} className="button primary small" style={{ textDecoration: "none" }}>
        Update now
      </a>
      <button type="button" className="button quiet small" onClick={later}>
        Later
      </button>
    </aside>
  );
}
