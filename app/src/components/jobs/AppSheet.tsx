// Read-first application sheet. Shows employer, role, stage chip (which opens
// StageCard with mis-tap rules), next deadline, file marks, notes and timeline.
// Actions to edit details, add a timeline entry, and delete the application sit at the foot.

import { Sheet } from "../Sheet";
import {
  currentStageSince,
  deleteApplication,
  formatDate,
  inStageWords,
  isOpen,
  restoreApplication,
  SLOTS,
} from "../../lib/jobs";
import type { ApplicationEventRow, ApplicationRow } from "../../lib/types";
import { showToast } from "../../lib/ui";
import { Deadline, SlotRow, StageButton, Timeline } from "./Controls";
import { navigate } from "../../lib/router";

export function AppSheet({
  app,
  events,
  onClose,
  onEdit,
  onAddEntry,
}: {
  app: ApplicationRow;
  events: ApplicationEventRow[];
  onClose: () => void;
  onEdit?: () => void;
  onAddEntry?: () => void;
}) {
  const since = currentStageSince(app, events);
  const open = isOpen(app);
  const sinceWords = since && open ? inStageWords(since) : null;

  const remove = async () => {
    onClose();
    await deleteApplication(app.id);
    showToast(`${app.employer || "Application"} deleted.`, {
      label: "Undo",
      run: () => void restoreApplication(app.id),
    });
  };

  const handleEdit = () => {
    if (onEdit) {
      onEdit();
    } else {
      navigate({ view: "jobs", app: app.id, edit: true });
    }
  };

  const handleAddEntry = () => {
    if (onAddEntry) {
      onAddEntry();
    } else {
      navigate({ view: "jobs", app: app.id, entry: "new" });
    }
  };

  const footer = (
    <div className="app-sheet-foot">
      <div className="app-sheet-foot-actions">
        <button type="button" className="button" onClick={handleEdit}>
          Edit details
        </button>
        <button type="button" className="button" onClick={handleAddEntry}>
          Add entry
        </button>
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      </div>
      <button type="button" className="quiet danger" onClick={remove}>
        Delete application
      </button>
    </div>
  );

  return (
    <Sheet
      open={true}
      onClose={onClose}
      title={app.employer || "Application"}
      subtitle={app.role || undefined}
      footer={footer}
      className="app-sheet"
      tall
    >
      <div className="app-sheet-body">
        <div className="app-sheet-section app-sheet-meta-group">
          <div className="app-sheet-field">
            <span className="field-label">Stage</span>
            <div className="app-sheet-stage-wrap">
              <StageButton app={app} since={since} />
              {sinceWords && <span className="stage-since muted">{sinceWords}</span>}
            </div>
          </div>

          <div className="field-pair">
            <div className="app-sheet-field">
              <span className="field-label">Applied</span>
              <span className="app-sheet-val">{app.applied ? formatDate(app.applied) : "Not recorded"}</span>
            </div>
            <div className="app-sheet-field">
              <span className="field-label">Next deadline</span>
              <Deadline app={app} />
            </div>
          </div>
        </div>

        <div className="app-sheet-section">
          <h3 className="detail-head">Files</h3>
          <ul className="slot-list" aria-label="Files">
            {SLOTS.map((slot) => (
              <SlotRow key={slot.name} app={app} slot={slot} />
            ))}
          </ul>
        </div>

        <div className="app-sheet-section">
          <h3 className="detail-head">Notes</h3>
          {app.notes ? (
            <p className="app-sheet-notes-text">{app.notes}</p>
          ) : (
            <p className="app-sheet-notes-text muted">No notes yet.</p>
          )}
        </div>

        <div className="app-sheet-section">
          <Timeline app={app} events={events} />
        </div>
      </div>
    </Sheet>
  );
}
