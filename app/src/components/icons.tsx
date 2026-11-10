// One line-icon set, drawn on a 20 by 20 grid with a 1.5 stroke, so every
// toolbar button reads at the same weight.

const paths: Record<string, React.ReactNode> = {
  back: <path d="M12.5 4.5 7 10l5.5 5.5" />,
  // For the phone's tab bar.
  home: <path d="M3.5 9.25 10 3.75l6.5 5.5v7h-4.25v-4.5h-4.5v4.5H3.5z" />,
  week: <><rect x="3" y="4.25" width="14" height="12.5" /><path d="M3 8h14M7 2.75v3M13 2.75v3M6 11h2M9 11h2M12 11h2M6 13.75h2M9 13.75h2" /></>,
  // Adapted from Lucide "settings" (v0.460, ISC licence), rescaled to the 20 grid.
  settings: <><path d="M10.165 2.5h-.33a1.5 1.5 0 0 0-1.5 1.5v.135a1.5 1.5 0 0 1-.75 1.297l-.323 .188a1.5 1.5 0 0 1-1.5 0l-.112-.06a1.5 1.5 0 0 0-2.047 .547l-.165 .285a1.5 1.5 0 0 0 .547 2.047l.112 .075a1.5 1.5 0 0 1 .75 1.29v.383a1.5 1.5 0 0 1-.75 1.305l-.112 .068a1.5 1.5 0 0 0-.547 2.047l.165 .285a1.5 1.5 0 0 0 2.047 .547l.112-.06a1.5 1.5 0 0 1 1.5 0l.323 .188a1.5 1.5 0 0 1 .75 1.297V16a1.5 1.5 0 0 0 1.5 1.5h.33a1.5 1.5 0 0 0 1.5-1.5v-.135a1.5 1.5 0 0 1 .75-1.297l.323-.188a1.5 1.5 0 0 1 1.5 0l.112 .06a1.5 1.5 0 0 0 2.047-.547l.165-.292a1.5 1.5 0 0 0-.547-2.047l-.112-.06a1.5 1.5 0 0 1-.75-1.305v-.375a1.5 1.5 0 0 1 .75-1.305l.112-.068a1.5 1.5 0 0 0 .547-2.047l-.165-.285a1.5 1.5 0 0 0-2.047-.547l-.112 .06a1.5 1.5 0 0 1-1.5 0l-.323-.188a1.5 1.5 0 0 1-.75-1.297V4a1.5 1.5 0 0 0-1.5-1.5z" /><circle cx="10" cy="10" r="2.25" /></>,
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
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  undo: <><path d="M3.5 8.5 7 5M3.5 8.5 7 12" /><path d="M3.5 8.5h7a5 5 0 0 1 5 5v1" /></>,
  redo: <><path d="m16.5 8.5-3.5-3.5M16.5 8.5 13 12" /><path d="M16.5 8.5h-7a5 5 0 0 0-5 5v1" /></>,
  // Two columns of dots, the usual sign that a row can be picked up.
  grip: <><circle cx="7.5" cy="5.5" r="1" fill="currentColor" /><circle cx="12.5" cy="5.5" r="1" fill="currentColor" /><circle cx="7.5" cy="10" r="1" fill="currentColor" /><circle cx="12.5" cy="10" r="1" fill="currentColor" /><circle cx="7.5" cy="14.5" r="1" fill="currentColor" /><circle cx="12.5" cy="14.5" r="1" fill="currentColor" /></>,
  close: <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />,
  annotations: <><path d="M4 3.75h12v9.5H9.5L6 16.25v-3H4Z" /></>,
  pages: <><rect x="3.75" y="2.75" width="5.5" height="7" /><rect x="10.75" y="2.75" width="5.5" height="7" /><rect x="3.75" y="11.25" width="5.5" height="6" /><rect x="10.75" y="11.25" width="5.5" height="6" /></>,
  outline: <path d="M4 5h12M4 10h12M7 15h9M4 15h.5M4 10h.5" />,
  keyboard: <><rect x="2.75" y="5.25" width="14.5" height="9.5" /><path d="M5.5 8h1M9.5 8h1M13.5 8h1M5.5 11.5h9" /></>,
  enlarge: <><path d="M13 3.5h3.5v3.5M7 16.5H3.5V13M16.5 3.5 11 9M3.5 16.5 9 11" /></>,
  minimize: <><path d="M16.5 7h-3.5V3.5M3.5 13H7v3.5M13 7l4-4M7 13l-4 4" /></>,
  // The play button over a video's picture and Listen bar.
  play: <path d="M7.25 5.25v9.5L15 10z" fill="currentColor" />,
  pause: <><path d="M6 5h2.5v10H6zM11.5 5H14v10h-2.5z" fill="currentColor" /></>,
  listen: <><path d="M3.5 11a6.5 6.5 0 0 1 13 0" /><rect x="2.5" y="11" width="3" height="5" rx="1" /><rect x="14.5" y="11" width="3" height="5" rx="1" /></>,
  prevTrack: <><path d="M4.5 5v10M14.5 5l-7 5 7 5z" fill="currentColor" /></>,
  nextTrack: <><path d="M15.5 5v10M5.5 5l7 5-7 5z" fill="currentColor" /></>,
  // The four ways to lay out a folder's readings.
  viewCompact: <path d="M3.5 4.75h13M3.5 8.25h13M3.5 11.75h13M3.5 15.25h13" />,
  viewNormal: <><rect x="3.25" y="3.75" width="4.5" height="4.5" /><rect x="3.25" y="11.75" width="4.5" height="4.5" /><path d="M10.25 5h6.5M10.25 7h4M10.25 13h6.5M10.25 15h4" /></>,
  viewIcons: <><rect x="3.25" y="3.25" width="5.5" height="5.5" /><rect x="11.25" y="3.25" width="5.5" height="5.5" /><rect x="3.25" y="11.25" width="5.5" height="5.5" /><rect x="11.25" y="11.25" width="5.5" height="5.5" /></>,
  viewLarge: <><rect x="3.25" y="3.25" width="13.5" height="9.75" /><path d="M3.25 16.25h8.5" /></>,
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
