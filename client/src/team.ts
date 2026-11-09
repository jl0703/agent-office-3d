// The team: people with a role and a reporting line, kept by the server in one file. The page only reads and changes it through these calls.

export type Person = { id: string; name: string; role: string; brief: string; reportsTo: string | null };
export type PersonFields = Omit<Person, "id">;

type FetchFn = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;
export type TeamResult = { ok: true; people: Person[] } | { ok: false; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function toPerson(raw: unknown): Person | null {
  if (!isRecord(raw)) return null;
  const { id, name, role, brief, reportsTo } = raw;
  if (typeof id !== "string" || typeof name !== "string" || typeof role !== "string" || typeof brief !== "string") return null;
  if (reportsTo !== null && typeof reportsTo !== "string") return null;
  return { id, name, role, brief, reportsTo };
}

const toPeople = (raw: unknown): Person[] | null => {
  const list = isRecord(raw) ? raw["people"] : null;
  if (!Array.isArray(list)) return null;
  const people = list.map(toPerson);
  return people.every((p): p is Person => p !== null) ? people : null;
};

/** The team, or null when it cannot be read (or the server has none). */
export async function getTeam(fetchFn: FetchFn = fetch): Promise<Person[] | null> {
  try {
    const res = await fetchFn("/api/team");
    return res.ok ? toPeople(await res.json()) : null;
  } catch {
    return null;
  }
}

export const TEAM_FAILURES: Record<string, string> = {
  one_top: "Only one person can be at the top. Pick who this person reports to.",
  unknown_manager: "That manager is no longer on the team.",
  unknown_person: "That person is no longer on the team.",
  cycle: "A person cannot report to someone who reports to them.",
  too_deep: "The line of reporting is too long (six levels at most).",
  too_many: "The team is full (40 people at most).",
  is_top: "The person at the top cannot be removed while others are on the team. Move them or remove the others first.",
  busy: "That person has work running. Stop it first.",
  not_empty: "The team is not empty, so the starter team was not added.",
  invalid_request: "Check the fields: a name and a role are needed (one line each, up to 60 characters); the brief is up to 1500.",
};

async function change(path: string, body: Record<string, unknown>, fetchFn: FetchFn): Promise<TeamResult> {
  try {
    const res = await fetchFn(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, confirm: true }) });
    if (res.ok) {
      const people = toPeople(await res.json().catch(() => null));
      return people ? { ok: true, people } : { ok: false, message: "The server's answer could not be read." };
    }
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; reason?: unknown };
    const code = [data.reason, data.error].find((v) => typeof v === "string") as string | undefined;
    if (code && TEAM_FAILURES[code]) return { ok: false, message: TEAM_FAILURES[code] };
    if (res.status === 403) return { ok: false, message: "The session has expired. Open the link printed in the terminal again." };
    return { ok: false, message: `Something went wrong (error ${res.status}). Nothing was changed.` };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

export const addPerson = (fields: PersonFields, fetchFn: FetchFn = fetch) => change("/api/team/people", fields, fetchFn);
export const updatePerson = (id: string, fields: Partial<PersonFields>, fetchFn: FetchFn = fetch) => change("/api/team/people/update", { id, ...fields }, fetchFn);
export const removePerson = (id: string, fetchFn: FetchFn = fetch) => change("/api/team/people/remove", { id }, fetchFn);
export const addStarterTeam = (fetchFn: FetchFn = fetch) => change("/api/team/starter", {}, fetchFn);

/** The line from a person up to the top, nearest manager first. A loop or a missing manager ends the line. */
export function chainOf(people: readonly Person[], id: string): Person[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const line: Person[] = [];
  for (let at = byId.get(id)?.reportsTo; at && line.length < people.length; ) {
    const p = byId.get(at);
    if (!p) break;
    line.push(p);
    at = p.reportsTo;
  }
  return line;
}

export const reportsOf = (people: readonly Person[], id: string): Person[] => people.filter((p) => p.reportsTo === id);

/** Everyone under a person, at any depth: they cannot be picked as that person's manager. */
export function belowOf(people: readonly Person[], id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const p of reportsOf(people, next)) {
      if (found.has(p.id)) continue;
      found.add(p.id);
      queue.push(p.id);
    }
  }
  return found;
}

export type OrgNode = { person: Person; reports: OrgNode[] };

/** The team as a tree: the person at the top first, then the others that report to nobody that is listed (a safety net, never expected). */
export function orgOf(people: readonly Person[]): OrgNode[] {
  const ids = new Set(people.map((p) => p.id));
  const build = (p: Person, seen: ReadonlySet<string>): OrgNode => ({ person: p, reports: reportsOf(people, p.id).filter((r) => !seen.has(r.id)).map((r) => build(r, new Set([...seen, r.id]))) });
  return people.filter((p) => p.reportsTo === null || !ids.has(p.reportsTo)).map((p) => build(p, new Set([p.id])));
}

/** The names a person reports to, for one line of text such as "Reports to Sam, then Alex". */
export function reportsLine(people: readonly Person[], id: string): string {
  const line = chainOf(people, id).map((p) => p.name);
  return line.length === 0 ? "Top of the team" : `Reports to ${line.join(", then ")}`;
}

export function demoTeam(): Person[] {
  const id = (n: number) => n.toString(16).padStart(12, "0");
  return [
    { id: id(1), name: "Alex", role: "CEO", brief: "Sets the direction.", reportsTo: null },
    { id: id(2), name: "Sam", role: "Engineering Lead", brief: "Leads the developers.", reportsTo: id(1) },
    { id: id(3), name: "Jordan", role: "QA Lead", brief: "Leads quality.", reportsTo: id(1) },
    { id: id(4), name: "Riley", role: "Frontend Developer", brief: "Builds the interface.", reportsTo: id(2) },
    { id: id(5), name: "Casey", role: "Backend Developer", brief: "Builds the server side.", reportsTo: id(2) },
    { id: id(6), name: "Morgan", role: "QA Engineer", brief: "Tests the change.", reportsTo: id(3) },
  ];
}
