// One line-icon set, drawn on a 20 by 20 grid with a 1.5 stroke, so every
// toolbar button reads at the same weight.

const paths: Record<string, React.ReactNode> = {
  back: <path d="M12.5 4.5 7 10l5.5 5.5" />,
  // For the phone's tab bar.
  home: <path d="M3.5 9.25 10 3.75l6.5 5.5v7h-4.25v-4.5h-4.5v4.5H3.5z" />,
  week: <><rect x="3" y="4.25" width="14" height="12.5" /><path d="M3 8h14M7 2.75v3M13 2.75v3M6 11h2M9 11h2M12 11h2M6 13.75h2M9 13.75h2" /></>,
  settings: <><circle cx="10" cy="10" r="2.5" /><path d="M10 2.75v2M10 15.25v2M2.75 10h2M15.25 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" /></>,
  goto: <><path d="M3.5 5.5h9M3.5 10h6M3.5 14.5h5" /><path d="m12.5 11.5 3 3-3 3M15.5 14.5h-4" /></>,
  sidebar: <><rect x="2.75" y="3.75" width="14.5" height="12.5" /><path d="M7.75 3.75v12.5M4.5 7h1.5M4.5 9.5h1.5" /></>,
  pane: <><rect x="2.75" y="3.75" width="14.5" height="12.5" /><path d="M12.25 3.75v12.5M14 7h1.5M14 9.5h1.5" /></>,
  zoomOut: <><circle cx="8.75" cy="8.75" r="5.25" /><path d="m12.5 12.5 4.5 4.5M6.5 8.75h4.5" /></>,
  zoomIn: <><circle cx="8.75" cy="8.75" r="5.25" /><path d="m12.5 12.5 4.5 4.5M6.5 8.75h4.5M8.75 6.5V11" /></>,
  fitWidth: <><rect x="2.75" y="4.75" width="14.5" height="10.5" /><path d="m6 10 2-2M6 10l2 2M6 10h8M14 10l-2-2M14 10l-2 2" /></>,
  up: <path d="M5 12.5 10 7.5l5 5" />,
  down: <path d="m5 7.5 5 5 5-5" />,
  highlight: <><path d="m6.5 13.5 7.75-7.75a1.5 1.5 0 0 0-2.1-2.1L4.4 11.4l-.9 3 3-.9Z" /><path d="M3 17h14" /></>,
  appearance: <><path d="M3 15.5 7 4.5l4 11M4.4 11.7h5.2" /><path d="M13 15.5v-4.25a2 2 0 0 1 4 0v4.25M13 13.5h4" /></>,
  search: <><circle cx="8.75" cy="8.75" r="5.25" /><path d="m12.5 12.5 4.5 4.5" /></>,
  check: <><circle cx="10" cy="10" r="7.25" /><path d="m6.75 10.25 2.25 2.25 4.25-4.5" /></>,
  more: <><circle cx="4.5" cy="10" r="0.9" fill="currentColor" /><circle cx="10" cy="10" r="0.9" fill="currentColor" /><circle cx="15.5" cy="10" r="0.9" fill="currentColor" /></>,
  notes: <><path d="M5 2.75h7l3 3v11.5H5Z" /><path d="M12 2.75v3h3M7.5 9.5h5M7.5 12h5M7.5 14.5h3" /></>,
  caret: <path d="m6.5 8.5 3.5 3.5 3.5-3.5" />,
  // Two columns of dots, the usual sign that a row can be picked up.
  grip: <><circle cx="7.5" cy="5.5" r="1" fill="currentColor" /><circle cx="12.5" cy="5.5" r="1" fill="currentColor" /><circle cx="7.5" cy="10" r="1" fill="currentColor" /><circle cx="12.5" cy="10" r="1" fill="currentColor" /><circle cx="7.5" cy="14.5" r="1" fill="currentColor" /><circle cx="12.5" cy="14.5" r="1" fill="currentColor" /></>,
  close: <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />,
  annotations: <><path d="M4 3.75h12v9.5H9.5L6 16.25v-3H4Z" /></>,
  pages: <><rect x="3.75" y="2.75" width="5.5" height="7" /><rect x="10.75" y="2.75" width="5.5" height="7" /><rect x="3.75" y="11.25" width="5.5" height="6" /><rect x="10.75" y="11.25" width="5.5" height="6" /></>,
  outline: <path d="M4 5h12M4 10h12M7 15h9M4 15h.5M4 10h.5" />,
  keyboard: <><rect x="2.75" y="5.25" width="14.5" height="9.5" /><path d="M5.5 8h1M9.5 8h1M13.5 8h1M5.5 11.5h9" /></>,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" strokeLinejoin="miter"
    >
      {paths[name]}
    </svg>
  );
}

// A toolbar button that shows only its icon. The label is its accessible
// name and its tooltip, with the shortcut where there is one.
export function IconButton({
  icon, label, shortcut, pressed, disabled, onClick, className,
}: {
  icon: IconName; label: string; shortcut?: string; pressed?: boolean; disabled?: boolean;
  onClick: () => void; className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}
