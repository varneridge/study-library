// Form for adding a new programme to the shortlist or editing an existing one.

import { useState } from "react";
import {
  computeProspectPatch,
  validateProspect,
  type ProspectValidation,
} from "../../lib/prospects";
import type { ProspectRow } from "../../lib/types";
import { DatePicker } from "../DatePicker";

export interface ProspectFormProps {
  mode: "new" | "edit";
  initialProspect?: ProspectRow;
  onSave: (patch: Partial<ProspectRow>) => Promise<void>;
  onCancel: () => void;
}

export function ProspectForm({
  mode,
  initialProspect,
  onSave,
  onCancel,
}: ProspectFormProps) {
  const [employer, setEmployer] = useState(initialProspect?.employer ?? "");
  const [programme, setProgramme] = useState(initialProspect?.programme ?? "");
  const [salary, setSalary] = useState(initialProspect?.salary ?? "");
  const [lastYearOpen, setLastYearOpen] = useState(initialProspect?.last_year_open ?? "");
  const [nextCheck, setNextCheck] = useState(initialProspect?.next_check ?? "");
  const [link, setLink] = useState(initialProspect?.link ?? "");
  const [notes, setNotes] = useState(initialProspect?.notes ?? "");
  const [errors, setErrors] = useState<ProspectValidation["errors"]>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);

  const isDirty = () => {
    if (mode === "new") {
      return Boolean(
        employer.trim() ||
        programme.trim() ||
        salary.trim() ||
        lastYearOpen.trim() ||
        nextCheck ||
        link.trim() ||
        notes.trim(),
      );
    }
    if (!initialProspect) return false;
    const current: Partial<ProspectRow> = {
      employer: employer.trim(),
      programme: programme.trim(),
      salary: salary.trim() || null,
      last_year_open: lastYearOpen.trim() || null,
      next_check: nextCheck || null,
      link: link.trim() || null,
      notes: notes.trim() || null,
    };
    const patch = computeProspectPatch(initialProspect, current);
    return Object.keys(patch).length > 0;
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (saving) return;

    const validation = validateProspect({
      employer,
      programme,
      next_check: nextCheck || null,
    });
    if (!validation.valid) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});

    const currentValues: Partial<ProspectRow> = {
      employer: employer.trim(),
      programme: programme.trim(),
      salary: salary.trim() || null,
      last_year_open: lastYearOpen.trim() || null,
      next_check: nextCheck || null,
      link: link.trim() || null,
      notes: notes.trim() || null,
    };

    if (mode === "edit" && initialProspect) {
      const patch = computeProspectPatch(initialProspect, currentValues);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
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
          <span className="field-label">Programme</span>
          <input
            type="text"
            value={programme}
            placeholder="Programme or role"
            enterKeyHint="next"
            onChange={(e) => {
              setProgramme(e.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>

        <label className="field">
          <span className="field-label">Salary</span>
          <input
            type="text"
            value={salary}
            placeholder="Salary, such as £32,250 or Not published"
            enterKeyHint="next"
            onChange={(e) => {
              setSalary(e.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>

        <div className="field-pair">
          <div className="field">
            <span className="field-label">Next check</span>
            <DatePicker
              value={nextCheck || null}
              label="Next check"
              hint="Next check turns red once the date arrives."
              clearable
              placeholder="Add check date"
              onChange={(d) => {
                setNextCheck(d || "");
                setConfirmDiscard(false);
                if (errors.next_check) setErrors((err) => ({ ...err, next_check: undefined }));
              }}
            />
            {errors.next_check && <span className="field-error">{errors.next_check}</span>}
          </div>

          <label className="field">
            <span className="field-label">Last year open</span>
            <input
              type="text"
              value={lastYearOpen}
              placeholder="Oct 2025, Rolling..."
              enterKeyHint="next"
              onChange={(e) => {
                setLastYearOpen(e.target.value);
                setConfirmDiscard(false);
              }}
            />
          </label>
        </div>

        <label className="field">
          <span className="field-label">Link</span>
          <input
            type="text"
            value={link}
            placeholder="https:// or Search: ..."
            enterKeyHint="next"
            onChange={(e) => {
              setLink(e.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>

        <label className="field">
          <span className="field-label">Notes</span>
          <textarea
            rows={3}
            value={notes}
            placeholder="Notes: intake details, eligibility, reminders"
            onChange={(e) => {
              setNotes(e.target.value);
              setConfirmDiscard(false);
            }}
          />
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" className="button primary" disabled={saving}>
          {saving ? "Saving…" : mode === "new" ? "Add to shortlist" : "Save changes"}
        </button>
        <button type="button" className="button" onClick={handleCancel}>
          {confirmDiscard ? "Discard changes" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
