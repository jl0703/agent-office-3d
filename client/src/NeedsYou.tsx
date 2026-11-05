import { Bell } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { Attention } from "./attention.ts";

const LABEL: Record<Attention["kind"], string> = { error: "Failed", cap: "Usage cap", waiting: "Waiting", result: "Result ready" };

/** The "Needs you" button in the header and the short list under it. */
export function NeedsYou({ items, onOpen }: { items: readonly Attention[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    const onOutside = (e: Event) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, [open]);

  return (
    <span className="needs" ref={root}>
      <button type="button" ref={button} className={items.length > 0 ? "needs-on" : undefined} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <Bell size={20} strokeWidth={1.75} aria-hidden="true" /> Needs you ({items.length})
      </button>
      {open && (
        <div id={listId} className="needs-list" role="region" aria-label="Needs you">
          {items.length === 0 ? (
            <p className="panel-note">Nothing needs you right now.</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpen(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className={`needs-kind needs-${item.kind}`}>{LABEL[item.kind]}</span>
                    <span className="needs-name">{item.name}</span>
                    <span className="needs-text">{item.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {items.length > 0 ? `${items.length} ${items.length === 1 ? "item needs" : "items need"} you` : ""}
      </span>
    </span>
  );
}
