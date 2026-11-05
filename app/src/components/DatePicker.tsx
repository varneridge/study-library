// The date picker. Its button shows the date chosen. Pressing it opens a card
// in the middle of the screen on a laptop, or a sheet from the foot of the
// screen on a phone, as the stage card does: a title saying what the date is
// for, a line saying what it is now, the month to choose from, and Clear date
// and Cancel kept apart at the foot. Escape, a tap outside and Cancel close it
// without a change, and focus goes back to the button that opened it.

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ISODate,
  addDays,
  addMonths,
  chosenDateText,
  formatISO,
  formatLong,
  monthGrid,
  parseISO,
  todayLocal,
  weekdayMon0,
} from "../lib/civilDate";
import { useLayer, usePortalTarget } from "../lib/layers";
import { Icon } from "./icons";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Below this width the card becomes a sheet, as choice cards do.
const PHONE = "(max-width: 44rem)";
const FIRST: ISODate = "1900-01-01";
const LAST: ISODate = "2199-12-31";

export interface DatePickerProps {
  value: ISODate | null;
  onChange: (value: ISODate | null) => void;
  // What the date is, as a screen reader names the button: "Next deadline".
  label: string;
  // The card's title, saying what the date is for. Defaults to the label.
  title?: string;
  // A line beneath, when the date has a use worth explaining.
  hint?: string;
  clearable?: boolean;
  min?: ISODate;
  max?: ISODate;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function DatePicker({
  value,
  onChange,
  label,
  title,
  hint,
  clearable = false,
  min,
  max,
  className,
  placeholder = "Add date",
  disabled = false,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleSelect = (next: ISODate | null) => {
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleDismiss = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className={`date-picker-wrap${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`date-picker-trigger${value ? "" : " is-empty"}`}
        aria-label={`${label}: ${value ? formatLong(value) : "none"}. Choose date`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((curr) => !curr); }}
      >
        <Icon name="calendar" size={15} />
        <span className="date-picker-trigger-text">{value ? formatLong(value) : placeholder}</span>
      </button>

      {open && (
        <DatePickerDialog
          triggerRef={triggerRef}
          value={value}
          label={label}
          title={title}
          hint={hint}
          clearable={clearable}
          min={min}
          max={max}
          onSelect={handleSelect}
          onDismiss={handleDismiss}
        />
      )}
    </div>
  );
}

export interface DatePickerDialogProps {
  triggerRef: React.RefObject<HTMLElement | null>;
  value: ISODate | null;
  label: string;
  title?: string;
  hint?: string;
  clearable?: boolean;
  min?: ISODate;
  max?: ISODate;
  onSelect: (value: ISODate | null) => void;
  onDismiss: (returnFocus?: boolean) => void;
}

export function DatePickerDialog({
  value,
  label,
  title,
  hint,
  clearable,
  min,
  max,
  onSelect,
  onDismiss,
}: DatePickerDialogProps) {
  const today = todayLocal();
  const clamp = (iso: ISODate): ISODate => {
    let next = iso;
    if (min && next < min) next = min;
    if (max && next > max) next = max;
    if (next < FIRST) next = FIRST;
    if (next > LAST) next = LAST;
    return next;
  };
  const validValue = value && parseISO(value) ? value : null;
  const initialDate = clamp(validValue || today);
  const initialParsed = parseISO(initialDate) || parseISO(today)!;

  const [viewYear, setViewYear] = useState(initialParsed.year);
  const [viewMonth, setViewMonth] = useState(initialParsed.month);
  const [focusedDate, setFocusedDate] = useState(initialDate);
  const [sheet] = useState(() => typeof window !== "undefined" && (window.matchMedia?.(PHONE).matches ?? false));

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const portalTarget = usePortalTarget();
  const headingId = useId();
  const nowId = useId();

  const isDateDisabled = (iso: ISODate) => {
    if (iso < FIRST || iso > LAST) return true;
    if (min && iso < min) return true;
    if (max && iso > max) return true;
    return false;
  };

  const moveFocusRef = useRef(false);

  // The cursor starts on the date chosen, or today, so the arrows work at once.
  useLayoutEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${initialDate}"]`)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusedDate}"]`)?.focus();
  }, [focusedDate]);

  // Escape closes the card before anything beneath it, such as a sheet.
  useLayer({ containerRef, onEscape: () => onDismiss(true) });

  const changeMonth = (delta: number) => {
    const p = parseISO(addMonths(formatISO(viewYear, viewMonth, 1), delta))!;
    setViewYear(p.year);
    setViewMonth(p.month);
    setFocusedDate(clamp(addMonths(focusedDate, delta)));
  };

  // While the card is open, Tab stays inside it.
  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const all = containerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]');
    const focusable = Array.from(all ?? []).filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Arrows, Home and End, Page Up and Page Down move within the month grid.
  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    if (!gridRef.current?.contains(e.target as Node)) return;
    let nextDate: ISODate | null = null;
    if (e.key === "ArrowLeft") nextDate = addDays(focusedDate, -1);
    else if (e.key === "ArrowRight") nextDate = addDays(focusedDate, 1);
    else if (e.key === "ArrowUp") nextDate = addDays(focusedDate, -7);
    else if (e.key === "ArrowDown") nextDate = addDays(focusedDate, 7);
    else if (e.key === "Home") nextDate = addDays(focusedDate, -weekdayMon0(focusedDate));
    else if (e.key === "End") nextDate = addDays(focusedDate, 6 - weekdayMon0(focusedDate));
    else if (e.key === "PageUp") nextDate = addMonths(focusedDate, e.shiftKey ? -12 : -1);
    else if (e.key === "PageDown") nextDate = addMonths(focusedDate, e.shiftKey ? 12 : 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isDateDisabled(focusedDate)) onSelect(focusedDate);
      return;
    } else return;
    e.preventDefault();
    const next = clamp(nextDate);
    moveFocusRef.current = true;
    setFocusedDate(next);
    const np = parseISO(next)!;
    if (np.year !== viewYear || np.month !== viewMonth) {
      setViewYear(np.year);
      setViewMonth(np.month);
    }
  };

  const days = monthGrid(viewYear, viewMonth);
  const previousMonth = MONTH_NAMES[(viewMonth + 10) % 12];
  const nextMonth = MONTH_NAMES[viewMonth % 12];

  return createPortal(
    <>
      {/* The scrim closes the card on a tap, and keeps the tap from reaching
          whatever lies beneath it. */}
      <div
        className="date-picker-scrim"
        aria-hidden="true"
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onDismiss(true); }}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={nowId}
        className={`date-picker-dialog${sheet ? " is-sheet" : " is-card"}`}
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        onKeyDown={handleContainerKeyDown}
      >
        <div className="date-picker-head">
          <h2 id={headingId} className="choice-title">{title ?? label}</h2>
          <p id={nowId} className="choice-now">{chosenDateText(validValue)}</p>
          {hint && <p className="date-picker-hint">{hint}</p>}
        </div>

        <div className="date-picker-header">
          <button
            type="button"
            className="icon-button date-picker-prev"
            aria-label={`Previous month, ${previousMonth}`}
            onClick={() => changeMonth(-1)}
          >
            <Icon name="caret" />
          </button>
          <h3 className="date-picker-title">{MONTH_NAMES[viewMonth - 1]} {viewYear}</h3>
          <button
            type="button"
            className="icon-button date-picker-next"
            aria-label={`Next month, ${nextMonth}`}
            onClick={() => changeMonth(1)}
          >
            <Icon name="caret" />
          </button>
        </div>

        <table ref={gridRef} className="date-picker-grid" role="grid" aria-label={`${label} calendar`} onKeyDown={handleGridKeyDown}>
          <thead>
            <tr role="row">
              {WEEKDAY_NAMES.map((wd) => (
                <th key={wd} scope="col" aria-label={wd} className="date-picker-weekday">{wd[0]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, weekIdx) => (
              <tr key={weekIdx} role="row">
                {days.slice(weekIdx * 7, weekIdx * 7 + 7).map((cell) => {
                  const isSelected = cell.iso === validValue;
                  const isToday = cell.iso === today;
                  const isFocused = cell.iso === focusedDate;
                  const disabled = isDateDisabled(cell.iso);
                  return (
                    <td
                      key={cell.iso}
                      role="gridcell"
                      aria-selected={isSelected}
                      aria-current={isToday ? "date" : undefined}
                      aria-disabled={disabled || undefined}
                      className="date-picker-cell"
                    >
                      <button
                        type="button"
                        data-iso={cell.iso}
                        data-focused={isFocused ? "true" : "false"}
                        tabIndex={isFocused ? 0 : -1}
                        disabled={disabled}
                        className={`date-cell-btn${isSelected ? " is-selected" : ""}${isToday ? " is-today" : ""}${isFocused ? " is-focused" : ""}${cell.inMonth ? "" : " is-outside"}`}
                        aria-label={formatLong(cell.iso) || String(cell.day)}
                        onClick={() => onSelect(cell.iso)}
                      >
                        {cell.day}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {MONTH_NAMES[viewMonth - 1]} {viewYear}
        </div>

        <div className="date-picker-foot">
          {clearable && validValue && (
            <button type="button" className="button date-picker-clear" onClick={() => onSelect(null)}>
              <Icon name="close" size={16} />
              <span>Clear date</span>
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button date-picker-cancel" onClick={() => onDismiss(true)}>
            Cancel
          </button>
        </div>
      </div>
    </>,
    portalTarget,
  );
}
