import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ISODate,
  addDays,
  addMonths,
  formatISO,
  formatLong,
  monthGrid,
  nextMonday,
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

export interface DatePickerProps {
  value: ISODate | null;
  onChange: (value: ISODate | null) => void;
  label: string;
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
  clearable = false,
  min,
  max,
  className,
  placeholder = "Add date",
  disabled = false,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleToggle = () => {
    if (disabled) return;
    setOpen((curr) => !curr);
  };

  const handleSelect = (next: ISODate | null) => {
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleDismiss = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
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
        onClick={handleToggle}
      >
        <Icon name="calendar" size={15} />
        <span className="date-picker-trigger-text">
          {value ? formatLong(value) : placeholder}
        </span>
      </button>

      {open && (
        <DatePickerDialog
          triggerRef={triggerRef}
          value={value}
          label={label}
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
  clearable?: boolean;
  min?: ISODate;
  max?: ISODate;
  onSelect: (value: ISODate | null) => void;
  onDismiss: (returnFocus?: boolean) => void;
}

export function DatePickerDialog({
  triggerRef,
  value,
  label,
  clearable,
  min,
  max,
  onSelect,
  onDismiss,
}: DatePickerDialogProps) {
  const today = todayLocal();
  const validValue = value && parseISO(value) ? value : null;
  let initialDate = validValue || today;
  if (min && initialDate < min) initialDate = min;
  if (max && initialDate > max) initialDate = max;
  if (initialDate < "1900-01-01") initialDate = "1900-01-01";
  if (initialDate > "2199-12-31") initialDate = "2199-12-31";

  const initialParsed = parseISO(initialDate) || parseISO(today)!;

  const [viewYear, setViewYear] = useState(initialParsed.year);
  const [viewMonth, setViewMonth] = useState(initialParsed.month);
  const [focusedDate, setFocusedDate] = useState(initialDate);

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const isCoarse = useRef(
    typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  );

  const portalTarget = usePortalTarget();
  const headingId = useId();

  // Position calculation for fine pointer popover
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const updatePosition = () => {
    if (isCoarse.current || !triggerRef.current || !containerRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const popoverRect = containerRef.current.getBoundingClientRect();

    let top = triggerRect.bottom + 6;
    let left = triggerRect.left;

    // Viewport flipping
    if (top + popoverRect.height > window.innerHeight - 10) {
      top = Math.max(10, triggerRect.top - popoverRect.height - 6);
    }
    if (left + popoverRect.width > window.innerWidth - 10) {
      left = Math.max(10, window.innerWidth - popoverRect.width - 10);
    }

    setCoords({ top, left });
  };

  useLayoutEffect(() => {
    updatePosition();
  }, [triggerRef]);

  // Recompute position on resize and capture-phase scroll
  useEffect(() => {
    if (isCoarse.current) return;
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [triggerRef]);

  const isDateDisabled = (iso: ISODate) => {
    if (iso < "1900-01-01" || iso > "2199-12-31") return true;
    if (min && iso < min) return true;
    if (max && iso > max) return true;
    return false;
  };

  const moveFocusRef = useRef(false);

  // Initial focus on mount (falling back to min/max if initial date is disabled)
  useLayoutEffect(() => {
    let target = initialDate;
    if (isDateDisabled(target)) {
      if (min && target < min) target = min;
      else if (max && target > max) target = max;
    }
    const initialEl = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-iso="${target}"]`
    );
    initialEl?.focus();
  }, []);

  // Move DOM focus when focusedDate changes via grid navigation
  useEffect(() => {
    if (!moveFocusRef.current) return;
    moveFocusRef.current = false;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-iso="${focusedDate}"]`
    );
    el?.focus();
  }, [focusedDate]);

  // Register in layer stack: Esc returns focus to trigger, outside click does NOT steal focus
  // Also ignores outside clicks on triggerRef to allow toggle
  useLayer({
    containerRef,
    onEscape: () => onDismiss(true),
    onOutside: (e) => {
      if (triggerRef.current?.contains(e.target as Node)) {
        return;
      }
      onDismiss(false);
    },
  });

  const changeMonth = (delta: number) => {
    const currentFirst = formatISO(viewYear, viewMonth, 1);
    const nextFirst = addMonths(currentFirst, delta);
    const p = parseISO(nextFirst)!;
    setViewYear(p.year);
    setViewMonth(p.month);
    let nextFocused = addMonths(focusedDate, delta);
    if (min && nextFocused < min) nextFocused = min;
    if (max && nextFocused > max) nextFocused = max;
    setFocusedDate(nextFocused);
  };

  // Tab trapping inside dialog
  const handleContainerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      const all = containerRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]'
      );
      if (!all || all.length === 0) return;
      const focusable = Array.from(all).filter((el) => {
        return (el as HTMLElement).tabIndex >= 0 && !el.hasAttribute("disabled");
      });
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  };

  // Grid keys (arrows, Home/End, PageUp/PageDown, Enter/Space) confined strictly to grid
  const handleGridKeyDown = (e: React.KeyboardEvent) => {
    if (!gridRef.current?.contains(e.target as Node)) return;

    let nextDate: ISODate | null = null;

    if (e.key === "ArrowLeft") {
      e.preventDefault();
      nextDate = addDays(focusedDate, -1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nextDate = addDays(focusedDate, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      nextDate = addDays(focusedDate, -7);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      nextDate = addDays(focusedDate, 7);
    } else if (e.key === "Home") {
      e.preventDefault();
      const dayOffset = weekdayMon0(focusedDate);
      nextDate = addDays(focusedDate, -dayOffset);
    } else if (e.key === "End") {
      e.preventDefault();
      const dayOffset = weekdayMon0(focusedDate);
      nextDate = addDays(focusedDate, 6 - dayOffset);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      nextDate = addMonths(focusedDate, e.shiftKey ? -12 : -1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      nextDate = addMonths(focusedDate, e.shiftKey ? 12 : 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isDateDisabled(focusedDate)) {
        onSelect(focusedDate);
      }
      return;
    }

    if (nextDate) {
      if (nextDate < "1900-01-01") nextDate = "1900-01-01";
      if (nextDate > "2199-12-31") nextDate = "2199-12-31";
      if (min && nextDate < min) nextDate = min;
      if (max && nextDate > max) nextDate = max;
      moveFocusRef.current = true;
      setFocusedDate(nextDate);
      const np = parseISO(nextDate)!;
      if (np.year !== viewYear || np.month !== viewMonth) {
        setViewYear(np.year);
        setViewMonth(np.month);
      }
    }
  };

  const days = monthGrid(viewYear, viewMonth);

  const quickChips = [
    { label: "Today", value: today },
    { label: "Tomorrow", value: addDays(today, 1) },
    { label: "Next Monday", value: nextMonday(today) },
  ];

  const dialogContent = (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className={`date-picker-dialog${isCoarse.current ? " is-sheet" : " is-popover"}`}
      style={!isCoarse.current ? { top: coords.top, left: coords.left } : undefined}
      tabIndex={-1}
      onPointerDown={(e) => e.preventDefault()}
      onKeyDown={handleContainerKeyDown}
    >
      <div className="date-picker-header">
        <h3 id={headingId} className="date-picker-title">
          {MONTH_NAMES[viewMonth - 1]} {viewYear}
        </h3>
        <div className="date-picker-nav">
          <button
            type="button"
            className="icon-button date-picker-prev"
            aria-label={`Previous month, ${MONTH_NAMES[(viewMonth + 10) % 12]}`}
            onClick={() => changeMonth(-1)}
          >
            <Icon name="caret" />
          </button>
          <button
            type="button"
            className="icon-button date-picker-next"
            aria-label={`Next month, ${MONTH_NAMES[viewMonth % 12]}`}
            onClick={() => changeMonth(1)}
          >
            <Icon name="caret" />
          </button>
        </div>
      </div>

      <div className="date-picker-chips" role="group" aria-label="Quick jumps">
        {quickChips.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={`date-chip${chip.value === value ? " is-active" : ""}`}
            disabled={isDateDisabled(chip.value)}
            onClick={() => onSelect(chip.value)}
          >
            {chip.label}
          </button>
        ))}
        {clearable && value && (
          <button
            type="button"
            className="date-chip is-clear"
            onClick={() => onSelect(null)}
          >
            Clear
          </button>
        )}
      </div>

      <table
        ref={gridRef}
        className="date-picker-grid"
        role="grid"
        aria-label={`${label} calendar`}
        onKeyDown={handleGridKeyDown}
      >
        <thead>
          <tr role="row">
            {WEEKDAY_NAMES.map((wd) => (
              <th key={wd} scope="col" aria-label={wd} className="date-picker-weekday">
                {wd[0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, weekIdx) => (
            <tr key={weekIdx} role="row">
              {days.slice(weekIdx * 7, weekIdx * 7 + 7).map((cell) => {
                const isSelected = cell.iso === value;
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
                      className={`date-cell-btn${isSelected ? " is-selected" : ""}${
                        isToday ? " is-today" : ""
                      }${isFocused ? " is-focused" : ""}${cell.inMonth ? "" : " is-outside"}`}
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

      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {MONTH_NAMES[viewMonth - 1]} {viewYear}
      </div>

      {isCoarse.current && (
        <div className="date-picker-foot">
          <button
            type="button"
            className="button"
            onClick={() => onDismiss(true)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(dialogContent, portalTarget);
}
