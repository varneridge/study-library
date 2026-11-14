// Read-first prospect sheet for the graduate shortlist. Shows employer,
// programme, status chip, next check date with its Checked button, last year
// open, salary, link and notes, with actions to edit, promote to an active
// application, or delete. Choosing Applied on the status chip promotes the
// prospect as well, since every status change goes through saveProspect.

import { Sheet } from "../Sheet";
import {
  deleteProspect,
  parseProspectLink,
  promoteProspectToApplication,
  prospectStatusOf,
  restoreProspect,
  saveProspect,
} from "../../lib/prospects";
import type { ApplicationRow, ProspectRow } from "../../lib/types";
import { showToast } from "../../lib/ui";
import { NextCheck, ProspectStatusButton } from "./ProspectControls";
import { navigate } from "../../lib/router";
import { Icon } from "../icons";
import { TextField } from "./Controls";

export function ProspectSheet({
  prospect,
  linkedApp,
  onClose,
}: {
  prospect: ProspectRow;
  linkedApp?: ApplicationRow;
  onClose: () => void;
}) {
  const isLinked = Boolean(linkedApp && !linkedApp.deleted);
  const canPromote = !isLinked && prospectStatusOf(prospect.status).cat !== "closed";
  const parsedLink = parseProspectLink(prospect.link);

  const remove = async () => {
    onClose();
    await deleteProspect(prospect.id);
    showToast(`${prospect.employer || "Programme"} removed from shortlist.`, {
      label: "Undo",
      run: () => void restoreProspect(prospect.id),
    });
  };

  const handleEdit = () => {
    void navigate({ view: "jobs", list: "shortlist", prospect: prospect.id, edit: true });
  };

  const handlePromote = async () => {
    await promoteProspectToApplication(prospect);
  };

  const footer = (
    <div className="app-sheet-foot">
      <div className="app-sheet-foot-actions">
        <button type="button" className="button" onClick={handleEdit}>
          Edit details
        </button>
        {isLinked ? (
          <button
            type="button"
            className="button"
            onClick={() => void navigate({ view: "jobs", app: linkedApp!.id })}
          >
            Open application
          </button>
        ) : canPromote ? (
          <button type="button" className="button" onClick={() => void handlePromote()}>
            Add to applications
          </button>
        ) : null}
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
      <button type="button" className="quiet danger" onClick={() => void remove()}>
        Delete from shortlist
      </button>
    </div>
  );

  return (
    <Sheet
      open={true}
      onClose={onClose}
      title={prospect.employer || "Programme"}
      subtitle={prospect.programme || undefined}
      footer={footer}
      className="app-sheet prospect-sheet"
      tall
    >
      <div className="app-sheet-body">
        <section className="app-sheet-status" aria-label="Where it stands">
          <div className="app-sheet-field app-sheet-stage-field">
            <span className="field-label">Your status</span>
            <div className="app-sheet-stage-wrap">
              <ProspectStatusButton prospect={prospect} linkedApp={linkedApp} />
            </div>
          </div>
          <div className="app-sheet-field">
            <span className="field-label">Next check</span>
            <NextCheck prospect={prospect} linkedApp={linkedApp} />
          </div>
          <div className="app-sheet-field">
            <span className="field-label">Last year open</span>
            <span className="app-sheet-val">{prospect.last_year_open || "Not recorded"}</span>
          </div>
          <div className="app-sheet-field">
            <span className="field-label">Salary</span>
            <span className="app-sheet-val">{prospect.salary || "Not recorded"}</span>
          </div>
        </section>

        <div className="app-sheet-section">
          <h3 className="detail-head">Link</h3>
          {parsedLink.kind === "url" ? (
            <p className="prospect-sheet-link-row">
              <a
                href={parsedLink.href}
                target="_blank"
                rel="noopener"
                className="prospect-sheet-link"
              >
                <span>{parsedLink.raw}</span>
                <Icon name="external" size={15} />
              </a>
            </p>
          ) : parsedLink.kind === "search" ? (
            <p className="prospect-sheet-link-row">
              <a
                href={parsedLink.href}
                target="_blank"
                rel="noopener"
                className="prospect-sheet-link"
              >
                <Icon name="search" size={15} />
                <span>{parsedLink.label}</span>
              </a>
            </p>
          ) : parsedLink.kind === "text" ? (
            <p className="app-sheet-notes-text">{parsedLink.label}</p>
          ) : (
            <p className="app-sheet-notes-text muted">No link recorded.</p>
          )}
        </div>

        <div className="app-sheet-section app-sheet-notes">
          <h3 className="detail-head">Notes</h3>
          <TextField
            multiline
            value={prospect.notes ?? ""}
            label="Notes"
            placeholder="Notes: intake details, eligibility, scheme streams, reminders..."
            onSave={(v) => void saveProspect(prospect.id, { notes: v || null })}
          />
        </div>
      </div>
    </Sheet>
  );
}
