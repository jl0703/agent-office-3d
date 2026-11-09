import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Modal } from "./Modal.tsx";
import { addPerson, addStarterTeam, belowOf, demoTeam, getTeam, orgOf, removePerson, reportsLine, reportsOf, updatePerson, type OrgNode, type Person, type PersonFields } from "./team.ts";

type View = "cards" | "chart";
type Dialog = { kind: "form"; editing: Person | null } | { kind: "remove"; person: Person } | { kind: "starter" } | null;

const EMPTY: PersonFields = { name: "", role: "", brief: "", reportsTo: null };

/** The team, read when the page opens: undefined while loading, null when it cannot be read. */
function useTeam(demo: boolean) {
  const [people, setPeople] = useState<Person[] | null | undefined>(demo ? demoTeam() : undefined);
  const reload = useCallback(async () => setPeople(await getTeam()), []);
  useEffect(() => {
    if (demo) return setPeople(demoTeam());
    setPeople(undefined);
    let live = true;
    void getTeam().then((p) => live && setPeople(p));
    return () => {
      live = false;
    };
  }, [demo]);
  return { people, setPeople, reload };
}

function PersonForm({ people, editing, demo, onDone, onClose }: { people: Person[]; editing: Person | null; demo: boolean; onDone: (people: Person[]) => void; onClose: () => void }) {
  const id = useId();
  const [fields, setFields] = useState<PersonFields>(editing ? { name: editing.name, role: editing.role, brief: editing.brief, reportsTo: editing.reportsTo } : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const blocked = editing ? new Set([editing.id, ...belowOf(people, editing.id)]) : new Set<string>();
  const hasTop = people.some((p) => p.reportsTo === null && p.id !== editing?.id);
  const ready = fields.name.trim() !== "" && fields.role.trim() !== "" && (fields.reportsTo !== null || !hasTop);
  const set = (change: Partial<PersonFields>) => setFields((f) => ({ ...f, ...change }));

  const save = async () => {
    if (demo) return setError("Demo mode: nothing is saved.");
    setBusy(true);
    setError("");
    const result = editing ? await updatePerson(editing.id, { ...fields, name: fields.name.trim(), role: fields.role.trim() }) : await addPerson({ ...fields, name: fields.name.trim(), role: fields.role.trim() });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    onDone(result.people);
  };

  return (
    <form
      className="person-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}
    >
      <label htmlFor={`${id}-name`}>Name</label>
      <input id={`${id}-name`} value={fields.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} autoComplete="off" />
      <label htmlFor={`${id}-role`}>Role</label>
      <input id={`${id}-role`} value={fields.role} maxLength={60} placeholder="Frontend Developer" onChange={(e) => set({ role: e.target.value })} autoComplete="off" />
      <label htmlFor={`${id}-boss`}>Reports to</label>
      <select id={`${id}-boss`} value={fields.reportsTo ?? ""} onChange={(e) => set({ reportsTo: e.target.value === "" ? null : e.target.value })}>
        <option value="" disabled={hasTop}>
          {hasTop ? "Nobody (the top is taken)" : "Nobody (top of the team)"}
        </option>
        {people
          .filter((p) => !blocked.has(p.id))
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}, {p.role}
            </option>
          ))}
      </select>
      <label htmlFor={`${id}-brief`}>What this role does and how it works</label>
      <textarea id={`${id}-brief`} value={fields.brief} maxLength={1500} rows={5} placeholder="Builds the user interface: accessible, responsive, simple." onChange={(e) => set({ brief: e.target.value })} />
      <p className="panel-note">The brief goes to the worker when this person is given a task. It is not shown anywhere else.</p>
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="submit" disabled={!ready || busy}>
          {busy ? "Saving…" : editing ? "Save" : "Add person"}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Chart({ nodes, people }: { nodes: OrgNode[]; people: Person[] }) {
  return (
    <ul className="org-tree">
      {nodes.map(({ person, reports }) => (
        <li key={person.id}>
          <span className="org-node">
            <strong>{person.name}</strong>, {person.role}
          </span>
          {reports.length > 0 && <Chart nodes={reports} people={people} />}
        </li>
      ))}
    </ul>
  );
}

/** The people on the team, who each reports to, and what they are for. Add, edit and remove open pop-ups; nothing changes until they are confirmed. */
export function TeamPage({ demo }: { demo: boolean }) {
  const { people, setPeople } = useTeam(demo);
  const [view, setView] = useState<View>("cards");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const close = () => !busy && (setDialog(null), setError(""));
  const done = (list: Person[], text: string) => {
    setPeople(list);
    setDialog(null);
    setError("");
    setMessage(text);
  };

  const confirm = async (kind: "remove" | "starter") => {
    if (demo) return setError("Demo mode: nothing is saved.");
    setBusy(true);
    setError("");
    const result = kind === "starter" ? await addStarterTeam() : dialog?.kind === "remove" ? await removePerson(dialog.person.id) : null;
    setBusy(false);
    if (!result) return;
    if (!result.ok) return setError(result.message);
    done(result.people, kind === "starter" ? "The starter team was added. Edit it to fit your work." : "Removed. Their reports now report to their manager.");
  };

  const list = people ?? [];
  const ready = Array.isArray(people);

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <header className="catalog-head">
        <span className="catalog-icon" aria-hidden="true">
          <Users size={28} strokeWidth={1.75} />
        </span>
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            Team
          </h1>
          <p className="catalog-blurb">The people who do the work, each with a role and a manager. Give a task to a person and a worker starts in that role.</p>
          <p className="panel-note" role="status" aria-live="polite">
            {demo ? "Demo mode: a made-up team. " : ""}
            {message || (ready ? `${list.length} ${list.length === 1 ? "person" : "people"}` : people === null ? "The team could not be read." : "Loading…")}
          </p>
        </div>
      </header>

      {ready && (
        <div className="section-row">
          <div className="chips" role="group" aria-label="View">
            {(["cards", "chart"] as View[]).map((v) => (
              <button key={v} type="button" className="chip-filter" aria-pressed={view === v} onClick={() => setView(v)}>
                {v === "cards" ? "Cards" : "Org chart"}
              </button>
            ))}
          </div>
          <button type="button" className="add-btn" onClick={() => setDialog({ kind: "form", editing: null })}>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add a person
          </button>
        </div>
      )}

      {ready && list.length === 0 && (
        <section className="settings-group" aria-labelledby="team-empty">
          <h2 id="team-empty">No team yet</h2>
          <p className="panel-note">Add people one by one, or start from a small team (a CEO, an engineering lead and a QA lead, two developers and a QA engineer) and change it to fit.</p>
          <button type="button" onClick={() => setDialog({ kind: "starter" })}>
            Set up a starter team
          </button>
        </section>
      )}

      {ready && list.length > 0 && view === "cards" && (
        <ul className="person-grid">
          {list.map((p) => (
            <li key={p.id} className="person-card">
              <h2>{p.name}</h2>
              <span className="chip">{p.role}</span>
              <p>{reportsLine(list, p.id)}</p>
              <p className="panel-note">{reportsOf(list, p.id).length === 0 ? "No one reports to them." : `${reportsOf(list, p.id).length} report to them.`}</p>
              <div className="task-foot">
                <button type="button" onClick={() => setDialog({ kind: "form", editing: p })}>
                  <Pencil size={16} strokeWidth={1.75} aria-hidden="true" /> Edit<span className="sr-only"> {p.name}</span>
                </button>
                <button type="button" onClick={() => setDialog({ kind: "remove", person: p })}>
                  <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /> Remove<span className="sr-only"> {p.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {ready && list.length > 0 && view === "chart" && (
        <nav aria-label="Who reports to whom">
          <Chart nodes={orgOf(list)} people={list} />
        </nav>
      )}

      <Modal open={dialog?.kind === "form"} onClose={close} title={dialog?.kind === "form" && dialog.editing ? `Edit ${dialog.editing.name}` : "Add a person"}>
        {dialog?.kind === "form" && <PersonForm people={list} editing={dialog.editing} demo={demo} onClose={close} onDone={(l) => done(l, dialog.editing ? "Saved." : "Added.")} />}
      </Modal>

      <Modal
        open={dialog?.kind === "remove"}
        onClose={close}
        title="Remove this person?"
        role="alertdialog"
        description={dialog?.kind === "remove" ? `${dialog.person.name}, ${dialog.person.role}, leaves the team. The people who report to them will report to their manager instead. Work they already did is not changed.` : ""}
      >
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void confirm("remove")}>
            {busy ? "Removing…" : "Remove"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal open={dialog?.kind === "starter"} onClose={close} title="Set up a starter team?" role="alertdialog" description="Adds six people: a CEO, an engineering lead, a QA lead, a frontend developer, a backend developer and a QA engineer, with a short brief each. You can edit or remove any of them afterwards.">
        {error && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => void confirm("starter")}>
            {busy ? "Adding…" : "Add the starter team"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Modal>
    </main>
  );
}
