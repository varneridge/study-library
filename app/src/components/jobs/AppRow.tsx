// An application row in the phone list. Scannable, with employer in serif,
// role, stage tag, and next deadline or duration in stage. Tapping opens the
// application sheet without changing anything.

import { href, navigate } from "../../lib/router";
import { deadlineState, deadlineWords, formatDate, inStageWords, isOpen, stageOf } from "../../lib/jobs";
import type { ApplicationRow } from "../../lib/types";

export function AppRow({
  app,
  since,
}: {
  app: ApplicationRow;
  since: string | null;
}) {
  const stage = stageOf(app.stage);
  const open = isOpen(app);
  const state = open ? deadlineState(app) : "none";
  const dWords = open ? deadlineWords(app) : null;
  const sWords = since && open ? inStageWords(since) : null;

  return (
    <li className={`app-card app-row-item${open ? "" : " closed"}`} data-app={app.id}>
      <a
        href={href({ view: "jobs", app: app.id })}
        className="app-row card-head"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          navigate({ view: "jobs", app: app.id });
        }}
        aria-label={`${app.employer || "Application"}${app.role ? `, ${app.role}` : ""}. Stage: ${stage.label}`}
      >
        <div className="app-row-main">
          <div className="app-row-top card-top">
            <span className="app-row-employer card-employer">
              {app.employer || <span className="muted">New application</span>}
            </span>
            <span className={`stage-tag cat-${stage.cat}`} title={stage.label}>
              {stage.label}
            </span>
          </div>
          {app.role && <span className="app-row-role card-role">{app.role}</span>}
        </div>
        <div className="app-row-meta card-meta">
          {open && app.next_deadline && (
            <span className={`app-row-due card-due state-${state}`}>
              Due {formatDate(app.next_deadline)}
              {dWords && <span className="app-row-due-words"> ({dWords})</span>}
            </span>
          )}
          {!open && app.applied && (
            <span className="app-row-applied muted">Applied {formatDate(app.applied)}</span>
          )}
          {sWords && <span className="app-row-since muted">{sWords}</span>}
        </div>
      </a>
    </li>
  );
}
