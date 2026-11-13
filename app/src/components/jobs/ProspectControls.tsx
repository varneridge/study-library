// Controls for the graduate shortlist: next check date, status choice card,
// order choice card, and link cell.

import { useEffect, useRef, useState } from "react";
import {
  changeProspectStatus,
  checkState,
  checkWords,
  effectiveProspectStatus,
  isProspectOpen,
  parseProspectLink,
  promoteProspectToApplication,
  PROSPECT_STATUS_GROUPS,
  PROSPECT_STATUSES,
  prospectStatusOf,
  saveProspect,
  type ProspectOrder,
} from "../../lib/prospects";
import { CATEGORY_LABEL, formatDate } from "../../lib/jobs";
import type { ApplicationRow, ProspectRow } from "../../lib/types";
import { ChoiceCard } from "../ChoiceCard";
import { Icon } from "../icons";
import { DateField, TextField } from "./Controls";
import { navigate } from "../../lib/router";

export function NextCheck({
  prospect,
  linkedApp,
  editable = true,
}: {
  prospect: ProspectRow;
  linkedApp?: ApplicationRow;
  editable?: boolean;
}) {
  if (!isProspectOpen(prospect, linkedApp)) {
    return (
      <span
        className="deadline state-none"
        aria-label="No check date, as this programme is closed"
      />
    );
  }
  const state = checkState(prospect, linkedApp);
  const words = checkWords(prospect, linkedApp);
  return (
    <span className={`deadline state-${state}`}>
      {editable ? (
        <DateField
          value={prospect.next_check}
          label="Next check"
          title={`Next check for ${prospect.employer || "this programme"}`}
          hint="Next check turns red once the date arrives."
          clearable
          empty="None"
          className="deadline-date"
          onSave={(v) => void saveProspect(prospect.id, { next_check: v })}
        />
      ) : (
        <span className="deadline-date">
          {prospect.next_check ? formatDate(prospect.next_check) : ""}
        </span>
      )}
      {words && <span className="deadline-words">{words}</span>}
    </span>
  );
}

export function ProspectStatusCard({
  open,
  onClose,
  anchor,
  prospect,
  linkedApp,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  prospect: ProspectRow;
  linkedApp?: ApplicationRow;
  onPick: (key: string) => void;
}) {
  const heading = `Status for ${prospect.employer || "this programme"}`;
  const current = prospect.status;
  const chosen = useRef(false);
  useEffect(() => {
    if (open) chosen.current = false;
  }, [open]);

  const choose = (key: string) => {
    if (chosen.current) return;
    chosen.current = true;
    onPick(key);
  };

  const canPromote = (!linkedApp || linkedApp.deleted) && prospectStatusOf(current).cat !== "closed";

  return (
    <ChoiceCard
      open={open}
      onClose={onClose}
      anchor={anchor}
      label={heading}
      className="stage-card status-card"
      initialFocus=".status-groups [aria-pressed='true'], .status-groups button"
      title={
        <>
          <h2 className="choice-title">{heading}</h2>
          <p className="choice-now">
            {linkedApp && !linkedApp.deleted
              ? `In applications: ${effectiveProspectStatus(prospect, linkedApp).label}`
              : `Now: ${prospectStatusOf(current).label}`}
          </p>
        </>
      }
    >
      <div className="status-groups" role="group" aria-label="Every status">
        {PROSPECT_STATUS_GROUPS.map((group) => (
          <div key={group.label} className="status-group" role="group" aria-label={group.label}>
            <span className="stage-row-label">{group.label}</span>
            <div className="stage-tiles">
              {group.keys.map((key) => {
                const st = prospectStatusOf(key);
                const on = key === current && (!linkedApp || linkedApp.deleted);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`stage-tile cat-${st.cat}`}
                    aria-pressed={on}
                    aria-label={st.label}
                    onClick={() => choose(key)}
                  >
                    <span>{st.label}</span>
                    {on && <Icon name="check" size={14} />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {linkedApp && !linkedApp.deleted ? (
        <div className="status-card-promote">
          <button
            type="button"
            className="choice-row"
            onClick={() => {
              onClose();
              void navigate({ view: "jobs", app: linkedApp.id });
            }}
          >
            <span>Open in applications</span>
          </button>
        </div>
      ) : canPromote ? (
        <div className="status-card-promote">
          <button
            type="button"
            className="choice-row"
            onClick={() => {
              if (chosen.current) return;
              chosen.current = true;
              onClose();
              void promoteProspectToApplication(prospect);
            }}
          >
            <span>Add to applications</span>
          </button>
        </div>
      ) : null}
    </ChoiceCard>
  );
}

export function ProspectStatusButton({
  prospect,
  linkedApp,
  label = "Your status",
}: {
  prospect: ProspectRow;
  linkedApp?: ApplicationRow;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const status = effectiveProspectStatus(prospect, linkedApp);
  const isLinked = Boolean(linkedApp && !linkedApp.deleted);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`stage-chip cat-${status.cat}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${status.label}. Change`}
        title={isLinked ? `In applications (${CATEGORY_LABEL[status.cat]})` : CATEGORY_LABEL[status.cat]}
        onClick={() => setOpen(true)}
      >
        <span className="stage-chip-text">{status.label}</span>
        <Icon name="caret" size={14} />
      </button>
      {isLinked && (
        <button
          type="button"
          className="quiet small prospect-in-apps"
          onClick={() => void navigate({ view: "jobs", app: linkedApp!.id })}
        >
          In applications
        </button>
      )}
      <ProspectStatusCard
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        prospect={prospect}
        linkedApp={linkedApp}
        onPick={(key) => {
          setOpen(false);
          if (key !== prospect.status) void changeProspectStatus(prospect, key);
        }}
      />
    </>
  );
}

const PROSPECT_ORDERS: { key: ProspectOrder; label: string }[] = [
  { key: "next_check", label: "Next check" },
  { key: "employer", label: "Employer" },
  { key: "status", label: "Your status" },
];

export function ProspectOrderButton({
  order,
  onChange,
}: {
  order: ProspectOrder;
  onChange: (order: ProspectOrder) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const current = PROSPECT_ORDERS.find((o) => o.key === order) ?? PROSPECT_ORDERS[0];
  return (
    <>
      <button
        ref={button}
        type="button"
        className="tool order-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Order: ${current.label}. Change`}
        onClick={() => setOpen(true)}
      >
        <span className="muted">Order:</span> {current.label}
        <Icon name="caret" size={14} />
      </button>
      <ChoiceCard
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        label="Order shortlist by"
        className="order-card"
        title={<h2 className="choice-title">Order shortlist by</h2>}
      >
        <div className="choice-rows">
          {PROSPECT_ORDERS.map((o) => (
            <button
              key={o.key}
              type="button"
              className="choice-row"
              aria-pressed={o.key === order}
              onClick={() => {
                setOpen(false);
                onChange(o.key);
              }}
            >
              <span>{o.label}</span>
              {o.key === order && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      </ChoiceCard>
    </>
  );
}

export function ProspectLinkCell({ prospect }: { prospect: ProspectRow }) {
  const parsed = parseProspectLink(prospect.link);
  const who = prospect.employer || "this programme";
  return (
    <div className="prospect-link-cell">
      <TextField
        wrap
        className="cell-input prospect-link-input"
        value={prospect.link ?? ""}
        label="Link"
        placeholder="https:// or Search: ..."
        onSave={(v) => void saveProspect(prospect.id, { link: v || null })}
      />
      {(parsed.kind === "url" || parsed.kind === "search") && (
        <a
          className="icon-button prospect-link-go"
          href={parsed.href}
          target="_blank"
          rel="noopener"
          title={parsed.kind === "search" ? `Search: ${parsed.query}` : `Open ${parsed.label}`}
          aria-label={parsed.kind === "search" ? `Search for ${parsed.query}` : `Open link for ${who}`}
        >
          <Icon name={parsed.kind === "search" ? "search" : "external"} size={15} />
        </a>
      )}
    </div>
  );
}
