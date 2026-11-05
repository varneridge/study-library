// Read-first application sheet. Shows employer, role, stage chip (which opens
// StageCard with mis-tap rules), next deadline, file marks, notes and timeline.
// Actions to edit details, add a timeline entry, and delete the application sit at the foot.

import React, { useEffect, useRef, useState } from "react";
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
import { showToast, useCloseOnBack } from "../../lib/ui";
import { Deadline, SlotRow, StageButton, Timeline } from "./Controls";
import { href, navigate } from "../../lib/router";
import { notesQueue, type SaveStatus } from "../../lib/notesQueue";
import { useLayer } from "../../lib/layers";

function JobNotesEditor({
  app,
  onBack,
}: {
  app: ApplicationRow;
  onBack: () => void;
}) {
  const [text, setText] = useState(() => notesQueue.get(app.id, app.notes));
  const [status, setStatus] = useState<SaveStatus>(() => notesQueue.getStatus(app.id));
  const lastSavedRef = useRef(app.notes ?? "");

  useCloseOnBack(true, () => {
    void notesQueue.flush(app.id);
    onBack();
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      const notesUrl = href({ view: "jobs", app: app.id, tab: "notes" });
      window.history.replaceState(window.history.state, "", notesUrl);
    }
  }, [app.id]);

  useLayer({
    onEscape: () => {
      void notesQueue.flush(app.id);
      onBack();
    },
  });

  useEffect(() => {
    return notesQueue.subscribe(app.id, (st) => {
      setStatus(st);
      if (st === "saved") {
        lastSavedRef.current = notesQueue.getPersisted(app.id) ?? app.notes ?? "";
      }
    });
  }, [app.id, app.notes]);

  useEffect(() => {
    return () => {
      void notesQueue.flush(app.id);
    };
  }, [app.id]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setText(next);
    notesQueue.set(app.id, next, lastSavedRef.current);
  };

  const handleBlur = () => {
    void notesQueue.flush(app.id);
  };

  const handleRetry = () => {
    notesQueue.set(app.id, text, lastSavedRef.current);
    void notesQueue.flush(app.id);
  };

  const statusLabel =
    status === "saving"
      ? "Saving…"
      : status === "error"
      ? "Couldn’t save"
      : "Saved";

  return (
    <div className="job-notes-editor">
      <div className="job-notes-topbar">
        <button
          type="button"
          className="button small"
          onClick={() => {
            void notesQueue.flush(app.id);
            onBack();
          }}
        >
          Back to overview
        </button>
        <span className="job-notes-status muted small" aria-live="polite">
          {statusLabel}
          {status === "error" && (
            <button
              type="button"
              className="quiet small"
              style={{ marginLeft: "0.5rem" }}
              onClick={handleRetry}
            >
              Retry
            </button>
          )}
        </span>
      </div>
      <textarea
        className="job-notes-textarea"
        value={text}
        placeholder="Notes: contacts, interview questions, preparation, reminders..."
        autoFocus
        onChange={handleChange}
        onBlur={handleBlur}
      />
    </div>
  );
}

export function AppSheet({
  app,
  events,
  tab,
  onClose,
  onEdit,
  onAddEntry,
}: {
  app: ApplicationRow;
  events: ApplicationEventRow[];
  tab?: string;
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

  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (tab === "notes") {
      if (typeof window !== "undefined") {
        const overviewUrl = href({ view: "jobs", app: app.id });
        window.history.replaceState(window.history.state, "", overviewUrl);
      }
      setActiveTab("notes");
    } else {
      setActiveTab(undefined);
    }
  }, [tab, app.id]);

  const openNotes = () => {
    if (typeof window !== "undefined") {
      const overviewUrl = href({ view: "jobs", app: app.id });
      window.history.replaceState(window.history.state, "", overviewUrl);
    }
    setActiveTab("notes");
  };

  const closeNotes = () => {
    setActiveTab(undefined);
  };

  const isNotesMode = activeTab === "notes";

  const footer = isNotesMode ? (
    <div className="app-sheet-foot">
      <div className="app-sheet-foot-actions">
        <button
          type="button"
          className="button primary"
          onClick={() => {
            void notesQueue.flush(app.id);
            closeNotes();
          }}
        >
          Done
        </button>
      </div>
    </div>
  ) : (
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
      title={isNotesMode ? `${app.employer || "Application"} notes` : app.employer || "Application"}
      subtitle={app.role || undefined}
      footer={footer}
      className="app-sheet"
      tall
    >
      {isNotesMode ? (
        <JobNotesEditor app={app} onBack={closeNotes} />
      ) : (
        // On a phone the sections run in one column. On a laptop the card is
        // wider: where it stands across the top, the timeline down the left,
        // and the files and notes on the right.
        <div className="app-sheet-body">
          <section className="app-sheet-status" aria-label="Where it stands">
            <div className="app-sheet-field app-sheet-stage-field">
              <span className="field-label">Stage</span>
              <div className="app-sheet-stage-wrap">
                <StageButton app={app} since={since} />
                {sinceWords && <span className="stage-since muted">{sinceWords}</span>}
              </div>
            </div>
            <div className="app-sheet-field">
              <span className="field-label">Applied</span>
              <span className="app-sheet-val">{app.applied ? formatDate(app.applied) : "Not recorded"}</span>
            </div>
            <div className="app-sheet-field">
              <span className="field-label">Next deadline</span>
              <Deadline app={app} />
            </div>
          </section>

          <div className="app-sheet-section app-sheet-files">
            <h3 className="detail-head">Files</h3>
            <ul className="slot-list" aria-label="Files">
              {SLOTS.map((slot) => (
                <SlotRow key={slot.name} app={app} slot={slot} />
              ))}
            </ul>
          </div>

          <div className="app-sheet-section app-sheet-notes">
            <div className="app-sheet-section-head">
              <h3 className="detail-head">Notes</h3>
              <button type="button" className="quiet small" onClick={openNotes}>
                Open notes
              </button>
            </div>
            {app.notes ? (
              <p className="app-sheet-notes-text">{app.notes}</p>
            ) : (
              <p className="app-sheet-notes-text muted">No notes yet. Contacts, interview questions and what to prepare go here.</p>
            )}
          </div>

          <div className="app-sheet-section app-sheet-timeline">
            <Timeline
              app={app}
              events={events}
              onAddEntry={handleAddEntry}
              onEditEntry={(id) => navigate({ view: "jobs", app: app.id, entry: id })}
            />
          </div>
        </div>
      )}
    </Sheet>
  );
}
