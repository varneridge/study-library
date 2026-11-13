// A prospect card in the graduate shortlist on phone viewports (below 60rem).

import { href, navigate } from "../../lib/router";
import { formatDate } from "../../lib/jobs";
import {
  checkState,
  checkWords,
  effectiveProspectStatus,
  isProspectOpen,
} from "../../lib/prospects";
import type { ApplicationRow, ProspectRow } from "../../lib/types";
import { Icon } from "../icons";

export function ProspectRow({
  prospect,
  linkedApp,
}: {
  prospect: ProspectRow;
  linkedApp?: ApplicationRow;
}) {
  const status = effectiveProspectStatus(prospect, linkedApp);
  const open = isProspectOpen(prospect, linkedApp);
  const state = open ? checkState(prospect, linkedApp) : "none";
  const cWords = open ? checkWords(prospect, linkedApp) : null;
  const isLinked = Boolean(linkedApp && !linkedApp.deleted);

  return (
    <li className={`app-card-item${open ? "" : " is-closed"}`} data-prospect={prospect.id}>
      <a
        href={href({ view: "jobs", list: "shortlist", prospect: prospect.id })}
        className="app-card"
        data-employer={prospect.employer}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
          e.preventDefault();
          void navigate({ view: "jobs", list: "shortlist", prospect: prospect.id });
        }}
        aria-label={`${prospect.employer || "Programme"}${prospect.programme ? `, ${prospect.programme}` : ""}. Status: ${status.label}`}
      >
        <div className="app-card-head">
          <span className="app-card-employer">
            {prospect.employer || <span className="muted">New programme</span>}
          </span>
          <span className={`stage-tag cat-${status.cat}`} title={status.label}>
            {status.label}
          </span>
        </div>

        {prospect.programme && <div className="app-card-role">{prospect.programme}</div>}

        {open && prospect.next_check ? (
          <div className={`app-card-deadline state-${state}`}>
            <Icon name="clock" size={15} />
            <span className="deadline-text">
              <strong className="deadline-label">{cWords ? cWords : "Next check"}</strong>{" "}
              <span className="deadline-date">{formatDate(prospect.next_check)}</span>
            </span>
          </div>
        ) : open ? (
          <div className="app-card-deadline state-none">
            <span className="deadline-label muted">No next check date set</span>
          </div>
        ) : null}

        <div className="app-card-footer">
          <div className="app-card-meta">
            {prospect.salary && (
              <span className="app-meta-item app-meta-salary">{prospect.salary}</span>
            )}
            {prospect.last_year_open && (
              <span className="app-meta-item">Last open: {prospect.last_year_open}</span>
            )}
          </div>
          {isLinked && (
            <div className="app-card-slots" title="Added to applications">
              <span className="slot-badge">Applied</span>
            </div>
          )}
        </div>
      </a>
    </li>
  );
}
