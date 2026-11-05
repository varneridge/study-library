// Shared form for adding or editing a timeline entry.
// Used both in the phone's entry sheet and the laptop table's inline editor.
// Updates stage and duration consistently with pure stage progression rules.

import { useEffect, useRef, useState } from "react";
import {
  addManualEvent,
  entryDate,
  entryTimeText,
  removeEvent,
  saveEntry,
  stageOf,
} from "../../lib/jobs";
import type { ApplicationEventRow, ApplicationRow } from "../../lib/types";
import { showToast } from "../../lib/ui";
import { Icon } from "../icons";
import { StageCard } from "./Controls";
import { DatePicker } from "../DatePicker";
import { todayLocal } from "../../lib/civilDate";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface EntryFormProps {
  app: ApplicationRow;
  entry?: ApplicationEventRow;
  onDone: () => void;
  variant?: "sheet" | "inline";
}

export function EntryForm({
  app,
  entry,
  onDone,
  variant = "inline",
}: EntryFormProps) {
  const today = todayLocal();
  const timed = Boolean(entry && !DATE_ONLY.test(entry.at));
  const [stage, setStage] = useState(entry?.stage ?? app.stage);
  const [day, setDay] = useState(entry ? entryDate(entry.at) : today);
  const [time, setTime] = useState(timed && entry ? entryTimeText(entry.at) : "");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [picking, setPicking] = useState(false);
  const stageButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    stageButton.current?.focus();
  }, []);

  const valid = DATE_ONLY.test(day) && day <= today;

  const save = async () => {
    if (!valid || busy.current) return;
    busy.current = true;
    setSaving(true);
    const at = time ? new Date(`${day}T${time}`).toISOString() : day;
    try {
      if (entry) {
        await saveEntry(app, entry, { stage, at });
        showToast("Timeline entry changed.");
      } else {
        await addManualEvent(app.id, stage, at);
      }
      onDone();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!entry) return;
    await removeEvent(entry.id);
    onDone();
  };

  const chosen = stageOf(stage);

  return (
    <div
      className={`tl-editor${variant === "sheet" ? " in-sheet" : ""}`}
      role="group"
      aria-label={entry ? "Edit a timeline entry" : "Add a past event"}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !picking) {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="tl-fields">
        <span className="field">
          <span className="field-label">Stage</span>
          <button
            ref={stageButton}
            type="button"
            className={`stage-chip cat-${chosen.cat}`}
            aria-haspopup="dialog"
            aria-label={`Stage for this entry: ${chosen.label}. Change`}
            onClick={() => setPicking(true)}
          >
            <span className="stage-chip-text">{chosen.label}</span>
            <Icon name="caret" size={14} />
          </button>
        </span>
        <label className="field">
          <span className="field-label">Date</span>
          <DatePicker
            value={day || null}
            max={today}
            label="Entry date"
            title={`Date of this entry for ${app.employer || "this application"}`}
            hint="The day this step happened. Days after today can’t be chosen."
            placeholder="Choose date"
            onChange={(d) => setDay(d || "")}
          />
        </label>
        <label className="field">
          <span className="field-label">Time, if you know it</span>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
      </div>

      <div className="tl-actions">
        <button
          type="button"
          className="button primary"
          disabled={!valid || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : entry ? "Save entry" : "Add event"}
        </button>
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        {entry && (
          <button
            type="button"
            className="quiet danger tl-remove"
            onClick={() => void remove()}
          >
            Remove entry
          </button>
        )}
      </div>

      <StageCard
        open={picking}
        onClose={() => setPicking(false)}
        anchor={stageButton}
        app={app}
        current={stage}
        since={null}
        title="Stage for this entry"
        status={`Chosen: ${chosen.label}`}
        showNext={false}
        onPick={(key) => {
          setPicking(false);
          setStage(key);
        }}
      />
    </div>
  );
}
