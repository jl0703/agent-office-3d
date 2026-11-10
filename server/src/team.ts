import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AVATAR_PARTS, type AvatarPart } from "../../shared/avatar.ts";
import { realOps, renameWithRetry, type WriteOps } from "./managedStore.ts";

// The team: people with a role and a reporting line. One file in the data folder. The owner writes everything in it; workers have no route to it.

export const TEAM_FILE = "team.json";
export const MAX_PEOPLE = 40;
export const MAX_DEPTH = 6;

// One line of plain text: no control characters and no text-direction tricks.
/* eslint-disable no-control-regex */
const oneLine = (max: number) =>
  z
  .string()
  .trim()
  .min(1)
  .max(max)
  .regex(/^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+$/);
export const Line = oneLine(60);
export const Title = oneLine(100);
/** A department: one short line, e.g. Engineering. A person with none is in no department. */
export const Department = oneLine(40);
// The role brief may span lines.
export const Brief = z.string().max(1500).regex(/^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/);
/* eslint-enable no-control-regex */
export const Id = z.string().regex(/^[0-9a-f]{12}$/);

const part = (k: AvatarPart) => z.number().int().min(0).max(AVATAR_PARTS[k] - 1);
/** A person's picture: one small number per part, each inside its list (see shared/avatar.ts). */
export const Avatar = z
  .object({ skin: part("skin"), hair: part("hair"), hairColor: part("hairColor"), eyes: part("eyes"), mouth: part("mouth"), glasses: part("glasses"), outfit: part("outfit"), outfitColor: part("outfitColor"), background: part("background") })
  .strict();

const Fields = { name: Line, role: Line, brief: Brief, reportsTo: Id.nullable(), avatar: Avatar.optional() };
// In the file a person either has a department or the key is missing; a request may send null to take it away.
const Person = z.object({ id: Id, ...Fields, department: Department.optional() }).strict();
const TeamFile = z.object({ version: z.literal(1), people: z.array(Person).max(MAX_PEOPLE) }).strict();

export type Person = z.infer<typeof Person>;
export const PersonInput = z.object({ ...Fields, department: Department.nullable().optional() }).strict();
export const PersonUpdate = z.object({ id: Id, ...Fields, department: Department.nullable().optional() }).partial({ name: true, role: true, brief: true, reportsTo: true, avatar: true }).strict();
export type PersonInput = z.infer<typeof PersonInput>;

export type TeamError = "invalid" | "too_many" | "unknown_person" | "unknown_manager" | "cycle" | "too_deep" | "one_top" | "is_top" | "not_empty" | "busy";

/** The reasons a whole team is not allowed: a manager that is not there, a loop, too deep a line, or more than one person at the top. */
export function checkTeam(people: readonly Person[]): TeamError | null {
  if (people.length > MAX_PEOPLE) return "too_many";
  const byId = new Map(people.map((p) => [p.id, p]));
  if (byId.size !== people.length) return "invalid";
  if (people.filter((p) => p.reportsTo === null).length > 1) return "one_top";
  for (const p of people) {
    if (p.reportsTo !== null && !byId.has(p.reportsTo)) return "unknown_manager";
  }
  for (const p of people) {
    let depth = 1;
    for (let at: Person | undefined = p; at?.reportsTo != null; depth++) {
      if (depth > people.length) return "cycle";
      at = byId.get(at.reportsTo);
    }
    if (depth > MAX_DEPTH) return "too_deep";
  }
  return null;
}

/** The line from a person up to the top, nearest manager first. */
export function chainOf(people: readonly Person[], id: string): Person[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const line: Person[] = [];
  for (let at = byId.get(id)?.reportsTo; at && line.length <= MAX_DEPTH; ) {
    const p = byId.get(at);
    if (!p) break;
    line.push(p);
    at = p.reportsTo;
  }
  return line;
}

const newId = () => randomBytes(6).toString("hex");

/** A person as saved: no department key at all when there is none (a request's null means "none"). */
function tidy(person: Person | (Omit<Person, "department"> & { department?: string | null })): Person {
  const { department, ...rest } = person;
  return department ? { ...rest, department } : rest;
}

const STARTER: { key: string; name: string; role: string; boss: string | null; brief: string; department: string }[] = [
  { key: "ceo", name: "Alex", role: "CEO", boss: null, brief: "You set the direction and decide what matters most. You keep answers short and ask for the result, not the process.", department: "Management" },
  { key: "eng", name: "Sam", role: "Engineering Lead", boss: "ceo", brief: "You lead the developers. You break work into small steps, keep the design simple and check that each change is understood before it is made.", department: "Engineering" },
  { key: "qal", name: "Jordan", role: "QA Lead", boss: "ceo", brief: "You lead quality. You decide what must be tested, look for what could break, and say clearly what passed and what did not.", department: "Quality" },
  { key: "fe", name: "Riley", role: "Frontend Developer", boss: "eng", brief: "You build the user interface: accessible, responsive, simple. You check your work in the browser and keep changes small.", department: "Engineering" },
  { key: "be", name: "Casey", role: "Backend Developer", boss: "eng", brief: "You build the server side: validate input, handle errors, write tests with the code. You do not add anything that was not asked for.", department: "Engineering" },
  { key: "qa", name: "Morgan", role: "QA Engineer", boss: "qal", brief: "You write and run tests, try to break the change and report what you found with the steps to repeat it. You do not fix the code yourself.", department: "Quality" },
];

/** The team file: strict shape, atomic writes, a damaged file is set aside as `.bad` and reads as an empty team. */
export function createTeamStore(dir: string, ops: WriteOps = realOps) {
  const file = join(dir, TEAM_FILE);
  let current: Promise<Person[]> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const load = () =>
    (current ??= (async (): Promise<Person[]> => {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        current = undefined; // a read that failed for another reason must not look like an empty team, or the next save would overwrite a good file
        throw error;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      const parsed = TeamFile.safeParse(raw);
      if (!parsed.success || checkTeam(parsed.data.people) !== null) {
        await rename(file, `${file}.bad`).catch(() => {});
        return [];
      }
      return parsed.data.people;
    })());

  async function save(people: Person[]) {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await ops.writeFile(tmp, JSON.stringify({ version: 1, people }));
      await renameWithRetry(ops, tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  /** Saves `next` when it is a valid team; the cache only moves on after the write worked. */
  async function commit(next: Person[]): Promise<TeamError | null> {
    const problem = checkTeam(next);
    if (problem) return problem;
    await save(next);
    current = Promise.resolve(next);
    return null;
  }

  type Done = { ok: true; people: Person[]; person?: Person } | { ok: false; code: TeamError };
  const fail = (code: TeamError): Done => ({ ok: false, code });

  return {
    list: () => enqueue(async () => [...(await load())]),
    add: (input: PersonInput) =>
      enqueue(async (): Promise<Done> => {
        const people = await load();
        const person: Person = tidy({ id: newId(), ...input });
        const problem = await commit([...people, person]);
        return problem ? fail(problem) : { ok: true, people: [...(await load())], person };
      }),
    update: (id: string, change: Partial<PersonInput>) =>
      enqueue(async (): Promise<Done> => {
        const people = await load();
        const old = people.find((p) => p.id === id);
        if (!old) return fail("unknown_person");
        const person: Person = tidy({ ...old, ...change });
        const problem = await commit(people.map((p) => (p.id === id ? person : p)));
        return problem ? fail(problem) : { ok: true, people: [...(await load())], person };
      }),
    /** Removing someone moves their reports up to their manager. The one at the top cannot be removed while others remain. `isBusy` refuses while that person has work running. */
    remove: (id: string, isBusy: (id: string) => boolean = () => false) =>
      enqueue(async (): Promise<Done> => {
        const people = await load();
        const old = people.find((p) => p.id === id);
        if (!old) return fail("unknown_person");
        if (isBusy(id)) return fail("busy");
        if (old.reportsTo === null && people.length > 1) return fail("is_top");
        const next = people.filter((p) => p.id !== id).map((p) => (p.reportsTo === id ? { ...p, reportsTo: old.reportsTo } : p));
        const problem = await commit(next);
        return problem ? fail(problem) : { ok: true, people: [...(await load())] };
      }),
    /** The starter team, only into an empty team. */
    starter: () =>
      enqueue(async (): Promise<Done> => {
        if ((await load()).length > 0) return fail("not_empty");
        const ids = new Map(STARTER.map((s) => [s.key, newId()]));
        const people = STARTER.map((s): Person => ({ id: ids.get(s.key) as string, name: s.name, role: s.role, brief: s.brief, department: s.department, reportsTo: s.boss === null ? null : (ids.get(s.boss) as string) }));
        const problem = await commit(people);
        return problem ? fail(problem) : { ok: true, people: [...(await load())] };
      }),
  };
}
export type TeamStore = ReturnType<typeof createTeamStore>;
