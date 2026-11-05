// Chooses how a folder's readings are laid out, as File Explorer's view
// buttons do. The current choice is the raised button of the segmented control.

import { VIEW_MODES, type ReadingViewMode } from "../lib/views";
import { Icon } from "./icons";

export function ViewSwitcher({ mode, onChange }: { mode: ReadingViewMode; onChange: (mode: ReadingViewMode) => void }) {
  return (
    <div className="segmented view-switcher" role="group" aria-label="View">
      {VIEW_MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          className="tool"
          aria-pressed={mode === m.value}
          aria-label={m.label}
          title={m.label}
          onClick={() => onChange(m.value)}
        >
          <Icon name={m.icon} size={16} />
        </button>
      ))}
    </div>
  );
}
