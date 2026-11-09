import { Plus } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import type { Agent } from "../../shared/events.ts";
import { Modal } from "./Modal.tsx";
import { addTask, demoOwnTasks, getOwnTasks, removeTask, startTask, updateTask, type OwnTask, type TasksResult } from "./ownTasks.ts";
import { loadRecent, remember } from "./recent.ts";
import { demoFindings, getFindings, type Finding } from "./research.ts";
import { hrefFor } from "./route.ts";
import { COLUMNS, COLUMN_EMPTY, COLUMN_WORD, tasksOf, type Task } from "./tasks.ts";
import { demoTeam, getTeam, type Person } from "./team.ts";
import { demoBuilds, getBuilds, type Build } from "./workshop.ts";

const POLL_MS = 15_000;

type Work = { builds: Build[]; findings: Finding[]; own: OwnTask[]; team: Person[] };
const demoWork = (): Work => ({ builds: demoBuilds(), findings: demoFindings(), own: demoOwnTasks(), team: demoTeam() });

/** Everything on the board except the agents, read when the page opens and every few seconds. A failed read keeps what is already shown. */
function useWork(demo: boolean) {
  const [work, setWork] = useState<Work>(demo ? demoWork() : { builds: [], findings: [], own: [], team: [] });
  const load = useCallback(async () => {
    const [b, f, o, t] = await Promise.all([getBuilds(), getFindings(), getOwnTasks(), getTeam()]);
    setWork((old) => ({ builds: b && b !== "off" ? b.builds : old.builds, findings: f ? f.findings : old.findings, own: o ?? old.own, team: t ?? old.team }));
  }, []);
  useEffect(() => {
    if (demo) return setWork(demoWork());
    setWork({ builds: [], findings: [], own: [], team: [] });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [demo, load]);
  return { work, setOwn: (own: OwnTask[]) => setWork((w) => ({ ...w, own })) };
}

type Dialog = { kind: "new" } | { kind: "start"; task: Task } | { kind: "remove"; task: Task } | null;

function Card({ task, team, demo, onOpenAgent, onChange, onAsk }: { task: Task; team: Person[]; demo: boolean; onOpenAgent: (id: string) => void; onChange: (r: TasksResult) => void; onAsk: (d: Dialog) => void }) {
  const id = useId();
  const [error, setError] = useState("");
  const own = task.own;
  const target = task.target;
  const open = target && ("agent" in target ? (
    <button type="button" className="link-btn" onClick={() => onOpenAgent(target.agent)}>
      Open in the office
    </button>
  ) : (
    <a className="link-btn" href={hrefFor({ page: "find", id: target.find })}>
      Open the find
    </a>
  ));

  const act = async (run: () => Promise<TasksResult>) => {
    if (demo) return setError("Demo mode: nothing is saved.");
    setError("");
    const r = await run();
    if (r.ok) onChange(r);
    else setError(r.message);
  };

  return (
    <li className="task-card">
      <h3>{task.title}</h3>
      {own ? (
        <>
          <label className="task-assign" htmlFor={`${id}-who`}>
            Assigned to
          </label>
          <select id={`${id}-who`} value={own.assignee ?? ""} disabled={own.done} onChange={(e) => void act(() => updateTask(own.id, { assignee: e.target.value === "" ? null : e.target.value }))}>
            <option value="">Nobody yet</option>
            {team.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}, {p.role}
              </option>
            ))}
          </select>
        </>
      ) : (
        <p className="panel-note">{task.who}</p>
      )}
      {task.text && <p>{task.text}</p>}
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <div className="task-foot">
        <span className="chip">{task.chip}</span>
        {open}
      </div>
      {own && (
        <div className="task-foot">
          {!own.done && (
            <button type="button" disabled={own.assignee === null || task.running === true} onClick={() => onAsk({ kind: "start", task })}>
              Start<span className="sr-only"> {task.title}</span>
            </button>
          )}
          <button type="button" onClick={() => void act(() => updateTask(own.id, { done: !own.done }))}>
            {own.done ? "Reopen" : "Mark done"}
            <span className="sr-only"> {task.title}</span>
          </button>
          <button type="button" onClick={() => onAsk({ kind: "remove", task })}>
            Remove<span className="sr-only"> {task.title}</span>
          </button>
        </div>
      )}
    </li>
  );
}

function NewTask({ team, demo, onDone, onClose }: { team: Person[]; demo: boolean; onDone: (r: TasksResult) => void; onClose: () => void }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (demo) return setError("Demo mode: nothing is saved.");
    setBusy(true);
    setError("");
    const r = await addTask({ title: title.trim(), details, assignee });
    setBusy(false);
    if (r.ok) onDone(r);
    else setError(r.message);
  };
  return (
    <form
      className="person-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() !== "" && !busy) void save();
      }}
    >
      <label htmlFor={`${id}-title`}>Title</label>
      <input id={`${id}-title`} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      <label htmlFor={`${id}-details`}>Details</label>
      <textarea id={`${id}-details`} value={details} maxLength={1500} rows={4} onChange={(e) => setDetails(e.target.value)} />
      <label htmlFor={`${id}-who`}>Assigned to</label>
      <select id={`${id}-who`} value={assignee ?? ""} onChange={(e) => setAssignee(e.target.value === "" ? null : e.target.value)}>
        <option value="">Nobody yet</option>
        {team.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}, {p.role}
          </option>
        ))}
      </select>
      {team.length === 0 && (
        <p className="panel-note">
          There is no team yet. Add people on the <a href={hrefFor({ page: "team" })}>Team page</a> to give tasks out.
        </p>
      )}
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="submit" disabled={title.trim() === "" || busy}>
          {busy ? "Saving…" : "Add the task"}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function StartTask({ task, demo, onDone, onClose }: { task: Task; demo: boolean; onDone: (r: TasksResult) => void; onClose: () => void }) {
  const id = useId();
  const [recent] = useState(loadRecent);
  const [cwd, setCwd] = useState(recent.folders[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const own = task.own;
  if (!own) return null;
  const go = async () => {
    if (demo) return setError("Demo mode: nothing is started.");
    setBusy(true);
    setError("");
    const r = await startTask(own.id, cwd.trim());
    setBusy(false);
    if (r.ok) {
      remember(cwd.trim(), "", undefined, recent);
      onDone(r);
    } else setError(r.message);
  };
  return (
    <form
      className="person-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (cwd.trim() !== "" && !busy) void go();
      }}
    >
      <p>
        Starts <strong>{task.assignee ?? "the person"}</strong> on <strong>{task.title}</strong>. A worker in that role plans first and waits for your approval before it changes anything. It uses model time within the usual cost limits.
      </p>
      <label htmlFor={`${id}-folder`}>Folder (full path)</label>
      <input id={`${id}-folder`} value={cwd} maxLength={1000} placeholder="C:\path\to\project" onChange={(e) => setCwd(e.target.value)} autoComplete="off" />
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="submit" disabled={cwd.trim() === "" || busy}>
          {busy ? "Starting…" : "Start"}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The owner's tasks and what the agents are doing, as a board with four columns. A column follows the state of the work, so cards are not dragged. */
export function TasksPage({ agents, demo, onOpenAgent }: { agents: readonly Agent[]; demo: boolean; onOpenAgent: (id: string) => void }) {
  const { work, setOwn } = useWork(demo);
  const columns = tasksOf(agents, work.builds, work.findings, work.own, work.team);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setDialog(null);
    setError("");
  };
  const changed = (r: TasksResult, text: string) => {
    if (r.ok) setOwn(r.tasks);
    setMessage(text);
    close();
  };
  const remove = async (t: Task) => {
    if (demo || !t.own) return setError("Demo mode: nothing is saved.");
    setBusy(true);
    setError("");
    const r = await removeTask(t.own.id);
    setBusy(false);
    if (r.ok) changed(r, "The task was removed.");
    else setError(r.message);
  };

  return (
    <main className="catalog" aria-labelledby="catalog-title">
      <header className="catalog-head">
        <div>
          <h1 id="catalog-title" tabIndex={-1}>
            Tasks
          </h1>
          <p className="catalog-blurb">Your tasks and what the agents are doing. Give a task to a person and start it: a worker in that role plans first and waits for you. Cards move by themselves as the work does.</p>
          <p className="panel-note" role="status" aria-live="polite">
            {demo ? "Demo mode: made-up work. " : ""}
            {message}
          </p>
        </div>
      </header>
      <div className="section-row">
        <span />
        <button type="button" className="add-btn" onClick={() => setDialog({ kind: "new" })}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> New task
        </button>
      </div>
      <div className="board-cols">
        {COLUMNS.map((c) => (
          <section key={c} className="board-col" aria-labelledby={`col-${c}`}>
            <h2 id={`col-${c}`}>
              {COLUMN_WORD[c]} <span className="count">{columns[c].length}</span>
            </h2>
            {columns[c].length === 0 ? (
              <p className="panel-note">{COLUMN_EMPTY[c]}</p>
            ) : (
              <ul>
                {columns[c].map((t) => (
                  <Card key={t.id} task={t} team={work.team} demo={demo} onOpenAgent={onOpenAgent} onChange={(r) => r.ok && setOwn(r.tasks)} onAsk={setDialog} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <Modal open={dialog?.kind === "new"} onClose={() => !busy && close()} title="New task">
        {dialog?.kind === "new" && <NewTask team={work.team} demo={demo} onClose={close} onDone={(r) => changed(r, "The task was added.")} />}
      </Modal>
      <Modal open={dialog?.kind === "start"} onClose={() => !busy && close()} title="Start this task?" role="alertdialog">
        {dialog?.kind === "start" && (
          <StartTask task={dialog.task} demo={demo} onClose={close} onDone={(r) => changed(r, "Started. Its plan will wait for your approval under Needs you.")} />
        )}
      </Modal>
      <Modal
        open={dialog?.kind === "remove"}
        onClose={() => !busy && close()}
        title="Remove this task?"
        role="alertdialog"
        description={dialog?.kind === "remove" ? `"${dialog.task.title}" is taken off the board. A worker already running on it is not stopped.` : ""}
      >
        {error && dialog?.kind === "remove" && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={() => dialog?.kind === "remove" && void remove(dialog.task)}>
            {busy ? "Removing…" : "Remove"}
          </button>
          <button type="button" disabled={busy} onClick={close}>
            Cancel
          </button>
        </div>
      </Modal>
    </main>
  );
}
