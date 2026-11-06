import { Bot, Boxes, Building2, Menu, Puzzle, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { hrefFor, KIND_WORD, type CatalogKind, type Route } from "./route.ts";

const ICONS = { skills: Puzzle, mcp: Boxes, agents: Bot } as const;
const ENTRIES: { label: string; route: Route; icon: typeof Puzzle }[] = [
  { label: "Office", route: { page: "office" }, icon: Building2 },
  ...(["skills", "mcp", "agents"] as CatalogKind[]).map((kind) => ({ label: KIND_WORD[kind], route: { page: "list", kind } as Route, icon: ICONS[kind] })),
];

const same = (a: Route, b: Route) => (a.page === "office" || b.page === "office" ? a.page === b.page : a.kind === b.kind);

/** The hamburger button and the left menu. Each choice is a link to its own page. */
export function Sidebar({ route }: { route: Route }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <button ref={button} type="button" className="icon-btn tip" aria-label="Menu" data-tip="Menu" aria-expanded={open} aria-controls={`${id}-drawer`} data-sidebar-button onClick={() => (open ? close() : setOpen(true))}>
        <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && <div className="drawer-backdrop" onClick={close} aria-hidden="true" />}
      {open && (
        <aside id={`${id}-drawer`} className="drawer" aria-labelledby={`${id}-title`}>
          <header className="panel-head">
            <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
              Menu
            </h2>
            <button type="button" className="icon-btn tip" aria-label="Close menu" data-tip="Close menu" onClick={close}>
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </header>
          <nav aria-label="Pages">
            <ul className="menu-list">
              {ENTRIES.map(({ label, route: target, icon: Icon }) => (
                <li key={label}>
                  <a href={hrefFor(target)} aria-current={same(route, target) ? "page" : undefined} onClick={() => setOpen(false)}>
                    <Icon size={20} strokeWidth={1.75} aria-hidden="true" /> {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>
      )}
    </>
  );
}
