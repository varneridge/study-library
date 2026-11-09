// An application card in the job search. Clear visual hierarchy with employer
// in serif, prominent stage pill, deadline callout banner, and metadata.
// Tapping opens the application sheet without changing anything.

import { href, navigate } from "../../lib/router";
import { deadlineState, deadlineWords, formatDate, inStageWords, isOpen, stageOf, SLOTS, slotColumn } from "../../lib/jobs";
import type { ApplicationRow } from "../../lib/types";
import { Icon } from "../icons";

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

  const filledSlots = SLOTS.filter((s) => Boolean(app[slotColumn(s.name)]));

  return (
    <li className={`app-card-item${open ? "" : " is-closed"}`} data-app={app.id}>
      <a
        href={href({ view: "jobs", app: app.id })}
        className="app-card"
        data-employer={app.employer}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          navigate({ view: "jobs", app: app.id });
        }}
        aria-label={`${app.employer || "Application"}${app.role ? `, ${app.role}` : ""}. Stage: ${stage.label}`}
      >
        <div className="app-card-head">
          <span className="app-card-employer">
            {app.employer || <span className="muted">New application</span>}
          </span>
          <span className={`stage-tag cat-${stage.cat}`} title={stage.label}>
            {stage.label}
          </span>
        </div>

        {app.role && <div className="app-card-role">{app.role}</div>}

        {open && app.next_deadline ? (
          <div className={`app-card-deadline state-${state}`}>
            <Icon name="clock" size={15} />
            <span className="deadline-text">
              <strong className="deadline-label">{dWords ? dWords : "Due"}</strong>
              <span className="deadline-date">{formatDate(app.next_deadline)}</span>
            </span>
          </div>
        ) : open ? (
          <div className="app-card-deadline state-none">
            <span className="deadline-label muted">No upcoming deadline set</span>
          </div>
        ) : null}

        <div className="app-card-footer">
          <div className="app-card-meta">
            {app.applied && (
              <span className="app-meta-item">Applied {formatDate(app.applied)}</span>
            )}
            {sWords && (
              <span className="app-meta-item">{sWords}</span>
            )}
          </div>

          {filledSlots.length > 0 && (
            <div className="app-card-slots" title="Files attached">
              {filledSlots.map((s) => (
                <span key={s.name} className="slot-badge">{s.short}</span>
              ))}
            </div>
          )}
        </div>
      </a>
    </li>
  );
}

export default AppRow;
