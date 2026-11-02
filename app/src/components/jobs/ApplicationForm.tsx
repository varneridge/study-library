// Shared form for creating a new application or editing an existing one.
// Validates employer and date formats, computes delta patch to write only
// modified fields, and detects remote conflicts on dirty fields.

import { useState } from "react";
import {
  computeApplicationPatch,
  detectApplicationConflict,
  todayIso,
  validateApplication,
  type ApplicationValidation,
} from "../../lib/jobs";
import type { ApplicationRow } from "../../lib/types";
import { db } from "../../lib/db";

export interface ApplicationFormProps {
  mode: "new" | "edit";
  initialApp?: ApplicationRow;
  onSave: (patch: Partial<ApplicationRow>) => Promise<void>;
  onCancel: () => void;
}

export function ApplicationForm({
  mode,
  initialApp,
  onSave,
  onCancel,
}: ApplicationFormProps) {
  const [employer, setEmployer] = useState(initialApp?.employer ?? "");
  const [role, setRole] = useState(initialApp?.role ?? "");
  const [applied, setApplied] = useState(initialApp?.applied ?? (mode === "new" ? todayIso() : ""));
  const [nextDeadline, setNextDeadline] = useState(initialApp?.next_deadline ?? "");
  const [notes, setNotes] = useState(initialApp?.notes ?? "");
  const [errors, setErrors] = useState<ApplicationValidation["errors"]>({});
  const [conflictPrompt, setConflictPrompt] = useState<Partial<ApplicationRow> | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);

  const isDirty = () => {
    if (mode === "new") {
      return Boolean(employer.trim() || role.trim() || notes.trim() || nextDeadline);
    }
    if (!initialApp) return false;
    const current = {
      employer: employer.trim(),
      role: role.trim(),
      applied: applied || null,
      next_deadline: nextDeadline || null,
      notes: notes.trim() || null,
    };
    const patch = computeApplicationPatch(initialApp, current);
    return Object.keys(patch).length > 0;
  };

  const handleSubmit = async (e?: React.FormEvent, forceOverwrite = false) => {
    if (e) e.preventDefault();
    if (saving) return;

    const validation = validateApplication({
      employer,
      role,
      applied: applied || null,
      next_deadline: nextDeadline || null,
    });
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});

    const currentValues: Partial<ApplicationRow> = {
      employer: employer.trim(),
      role: role.trim(),
      applied: applied || null,
      next_deadline: nextDeadline || null,
      notes: notes.trim() || null,
    };

    if (mode === "edit" && initialApp) {
      const patch = computeApplicationPatch(initialApp, currentValues);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }

      if (!forceOverwrite) {
        const liveApp = await db.applications.get(initialApp.id);
        const dirtyKeys = Object.keys(patch) as (keyof ApplicationRow)[];
        const conflict = detectApplicationConflict(
          initialApp.modified_at,
          liveApp?.modified_at,
          dirtyKeys,
          liveApp,
          initialApp,
        );
        if (conflict) {
          setConflictPrompt(patch);
          return;
        }
      }

      setSaving(true);
      try {
        await onSave(patch);
      } finally {
        setSaving(false);
      }
    } else {
      setSaving(true);
      try {
        await onSave(currentValues);
      } finally {
        setSaving(false);
      }
    }
  };

  const handleCancel = () => {
    if (isDirty()) {
      if (confirmDiscard) {
        onCancel();
      } else {
        setConfirmDiscard(true);
      }
    } else {
      onCancel();
    }
  };

  return (
    <form className="app-form" onSubmit={(e) => void handleSubmit(e)}>
      {conflictPrompt && (
        <div className="form-conflict-notice" role="alert">
          <p className="conflict-message">
            This application changed on another device.
          </p>
          <div className="conflict-actions">
            <button
              type="button"
              className="button primary"
              onClick={() => void handleSubmit(undefined, true)}
            >
              Keep my version
            </button>
            <button
              type="button"
              className="button quiet"
              onClick={onCancel}
            >
              Discard my edits
            </button>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <div className="form-discard-notice" role="alert">
          <p className="small muted">You have unsaved changes.</p>
        </div>
      )}

      <div className="app-form-fields">
        <label className="field">
          <span className="field-label">Employer</span>
          <input
            type="text"
            required
            autoFocus
            value={employer}
            placeholder="Employer"
            enterKeyHint="next"
            aria-invalid={Boolean(errors.employer)}
            onChange={(e) => {
              setEmployer(e.target.value);
              setConfirmDiscard(false);
              if (errors.employer) setErrors((err) => ({ ...err, employer: undefined }));
            }}
          />
          {errors.employer && <span className="field-error">{errors.employer}</span>}
        </label>

        <label className="field">
          <span className="field-label">Role</span>
          <input
            type="text"
            value={role}
            placeholder="Role"
            enterKeyHint="next"
            onChange={(e) => {
              setRole(e.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>

        <div className="field-pair">
          <label className="field">
            <span className="field-label">Applied</span>
            <input
              type="date"
              value={applied}
              onChange={(e) => {
                setApplied(e.target.value);
                setConfirmDiscard(false);
                if (errors.applied) setErrors((err) => ({ ...err, applied: undefined }));
              }}
            />
            {errors.applied && <span className="field-error">{errors.applied}</span>}
          </label>

          <label className="field">
            <span className="field-label">Next deadline</span>
            <input
              type="date"
              value={nextDeadline}
              onChange={(e) => {
                setNextDeadline(e.target.value);
                setConfirmDiscard(false);
                if (errors.next_deadline) setErrors((err) => ({ ...err, next_deadline: undefined }));
              }}
            />
            {errors.next_deadline && <span className="field-error">{errors.next_deadline}</span>}
          </label>
        </div>

        <label className="field">
          <span className="field-label">Notes</span>
          <textarea
            rows={3}
            value={notes}
            placeholder="Notes: contacts, interview times, what they asked"
            onChange={(e) => {
              setNotes(e.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" className="button primary" disabled={saving}>
          {saving ? "Saving…" : mode === "new" ? "Add application" : "Save changes"}
        </button>
        <button type="button" className="button" onClick={handleCancel}>
          {confirmDiscard ? "Discard changes" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
