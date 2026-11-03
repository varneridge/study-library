// A full-height modal sheet from the foot of the screen on phones, centering
// as a dialog on wider viewports. Built on a native <dialog>, with safe-area
// padding, sticky header and footer, and useCloseOnBack integration.

import { useEffect, useRef } from "react";
import { Icon } from "./icons";
import { useCloseOnBack } from "../lib/ui";
import { ModalRootContext, dismissTopLayer, useLayer, wasLayerRecentlyDismissed } from "../lib/layers";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  ariaLabel?: string;
  openerRef?: React.RefObject<HTMLElement>;
  tall?: boolean;
}

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  className,
  ariaLabel,
  openerRef,
  tall = false,
}: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const lastActiveRef = useRef<HTMLElement | null>(null);

  useCloseOnBack(open, onClose);
  useLayer({
    containerRef: ref,
    enabled: open,
    onEscape: onClose,
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open) {
      lastActiveRef.current = (openerRef?.current ?? document.activeElement) as HTMLElement | null;
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
      lastActiveRef.current?.focus?.();
    }
  }, [open, openerRef]);

  if (!open) return null;

  return (
    <ModalRootContext.Provider value={ref}>
      <dialog
        ref={ref}
        className={`sheet-dialog${tall ? " tall" : ""}${className ? ` ${className}` : ""}`}
        aria-label={typeof title === "string" ? title : ariaLabel}
        onCancel={(e) => {
          e.preventDefault();
          if (!wasLayerRecentlyDismissed()) {
            if (!dismissTopLayer()) onClose();
          }
        }}
        onClick={(e) => {
          if (e.target !== ref.current) return;
          if (wasLayerRecentlyDismissed()) return;
          const box = ref.current.getBoundingClientRect();
          const inside =
            e.clientX >= box.left &&
            e.clientX <= box.right &&
            e.clientY >= box.top &&
            e.clientY <= box.bottom;
          if (!inside) onClose();
        }}
      >
        <div className="sheet-head">
          <div className="sheet-title-group">
            <h2 className="sheet-title">{title}</h2>
            {subtitle && <p className="sheet-subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-button sheet-close"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="sheet-body">{children}</div>

        {footer && <div className="sheet-foot">{footer}</div>}
      </dialog>
    </ModalRootContext.Provider>
  );
}
