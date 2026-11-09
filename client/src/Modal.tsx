import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A pop-up window over the page, built on the browser's own modal dialog: it traps focus, closes on Escape, dims the page
 * behind it and puts focus back on the button that opened it. Its content is only mounted while it is open.
 */
export function Modal({ open, onClose, title, role = "dialog", description, children }: { open: boolean; onClose: () => void; title: string; role?: "dialog" | "alertdialog"; description?: string; children: ReactNode }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const pressedOn = useRef<EventTarget | null>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      heading.current?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="modal"
      role={role}
      aria-labelledby={`${id}-title`}
      {...(description ? { "aria-describedby": `${id}-desc` } : {})}
      onCancel={(e) => {
        e.preventDefault(); // Escape: let the page decide, so state and dialog never disagree
        onClose();
      }}
      // A drag that starts inside (selecting text) and ends on the backdrop must not close it: the press has to start there too.
      onPointerDown={(e) => (pressedOn.current = e.target)}
      onClick={(e) => e.target === dialog.current && pressedOn.current === dialog.current && onClose()}
      // If the browser closes it by itself, bring the page's state back in line.
      onClose={() => open && onClose()}
    >
      {open && (
        <div className="modal-body">
          <header className="modal-head">
            <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
              {title}
            </h2>
            <button type="button" className="icon-btn tip" aria-label="Close" data-tip="Close" onClick={onClose}>
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </header>
          {description && (
            <p id={`${id}-desc`} className="panel-note">
              {description}
            </p>
          )}
          {children}
        </div>
      )}
    </dialog>
  );
}
