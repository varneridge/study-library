// One card design for the job search, shared by applications and the
// shortlist so the two lists read the same way: employer and status pill,
// the role, a timing banner, then the meta tags and badges in the footer.
//
// The card is not itself a link. Its employer is the link, stretched across
// the whole card, so the card still opens with a tap anywhere while the
// controls inside it (the job link, a Checked button) stay real buttons and
// links of their own rather than being nested inside another link.

import type React from "react";
import { href, navigate } from "../../lib/router";
import type { DeadlineState } from "../../lib/jobs";
import type { ParsedLink } from "../../lib/prospects";
import { Icon } from "../icons";

type Route = Parameters<typeof navigate>[0];

export interface JobCardTiming {
  state: DeadlineState;
  // The countdown words, such as "in 3 days", or a plain label.
  label: string;
  // Already formatted for reading.
  date: string;
}

export interface JobCardBadge {
  key: string;
  label: string;
}

export interface JobCardProps {
  // Written as data-app or data-prospect, for tests and scrolling to a card.
  dataKey: "app" | "prospect";
  id: string;
  to: Route;
  employer: string;
  fallbackEmployer: string;
  subtitle?: string | null;
  status: { label: string; cat: string };
  statusWord: string;
  closed: boolean;
  // Shown only while the card is open. Null means no date has been set.
  timing: JobCardTiming | null;
  emptyTiming: string;
  // A control beside the timing, such as the shortlist's Checked button.
  timingAction?: React.ReactNode;
  salary?: string | null;
  link?: ParsedLink;
  meta?: (string | null | undefined | false)[];
  badges?: JobCardBadge[];
  badgesTitle?: string;
}

// The job link opens in a new tab without opening the card beneath it.
function MetaLink({ link, who }: { link: ParsedLink; who: string }) {
  if (link.kind !== "url" && link.kind !== "search") return null;
  const isSearch = link.kind === "search";
  return (
    <a
      className="app-meta-item app-meta-link"
      href={link.href}
      target="_blank"
      rel="noopener"
      title={isSearch ? link.label : `Open ${link.label}`}
      aria-label={isSearch ? `Search for ${link.query}` : `Open the job link for ${who}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Icon name={isSearch ? "search" : "external"} size={13} />
      <span className="app-meta-link-text">{isSearch ? "Search" : link.label}</span>
    </a>
  );
}

export function JobCard({
  dataKey,
  id,
  to,
  employer,
  fallbackEmployer,
  subtitle,
  status,
  statusWord,
  closed,
  timing,
  emptyTiming,
  timingAction,
  salary,
  link,
  meta = [],
  badges = [],
  badgesTitle,
}: JobCardProps) {
  const who = employer || fallbackEmployer.toLowerCase();
  const dataAttr = dataKey === "app" ? { "data-app": id } : { "data-prospect": id };
  const metaItems = meta.filter((m): m is string => Boolean(m));
  const hasMeta = Boolean(salary) || Boolean(link && (link.kind === "url" || link.kind === "search")) || metaItems.length > 0;

  return (
    <li className={`app-card-item${closed ? " is-closed" : ""}`} {...dataAttr}>
      <div className="app-card" data-employer={employer}>
        <div className="app-card-head">
          <a
            href={href(to)}
            className="app-card-employer app-card-link"
            aria-label={`${employer || fallbackEmployer}${subtitle ? `, ${subtitle}` : ""}. ${statusWord}: ${status.label}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              void navigate(to);
            }}
          >
            {employer || <span className="muted">New {fallbackEmployer.toLowerCase()}</span>}
          </a>
          <span className={`stage-tag cat-${status.cat}`} title={status.label}>
            {status.label}
          </span>
        </div>

        {subtitle && <div className="app-card-role">{subtitle}</div>}

        {!closed && (
          <div className={`app-card-deadline state-${timing ? timing.state : "none"}`}>
            {timing ? (
              <>
                <Icon name="clock" size={15} />
                <span className="deadline-text">
                  <strong className="deadline-label">{timing.label}</strong>{" "}
                  <span className="deadline-date">{timing.date}</span>
                </span>
              </>
            ) : (
              <span className="deadline-text">
                <span className="deadline-label muted">{emptyTiming}</span>
              </span>
            )}
            {timingAction}
          </div>
        )}

        {(hasMeta || badges.length > 0) && (
          <div className="app-card-footer">
            <div className="app-card-meta">
              {salary && <span className="app-meta-item app-meta-salary">{salary}</span>}
              {link && <MetaLink link={link} who={who} />}
              {metaItems.map((m) => (
                <span key={m} className="app-meta-item">{m}</span>
              ))}
            </div>
            {badges.length > 0 && (
              <div className="app-card-slots" title={badgesTitle}>
                {badges.map((b) => (
                  <span key={b.key} className="slot-badge">{b.label}</span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
