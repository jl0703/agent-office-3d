// A small read-only GitHub client for the research team. The host is fixed, input is validated
// before any request, answers are cut to a few fields, and every failure is a short code: no raw
// response, URL or header ever leaves this file. The token (optional) is only sent to api.github.com.

export const GITHUB_HOST = "api.github.com";
export const CACHE_MS = 10 * 60_000;
export const MAX_CALLS_PER_MINUTE = 8;
export const TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1_000_000;
export const MAX_LIMIT = 10;
const MAX_CACHE_ENTRIES = 200;

export type Repo = {
  full_name: string;
  stars: number;
  forks: number;
  open_issues: number;
  description: string;
  topics: string[];
  license: string | null;
  language: string | null;
  pushed_at: string | null;
  /** ISO date from GitHub, or null when GitHub did not give a valid one. */
  created_at: string | null;
  /** Stars divided by max(1, age in days), 1 decimal. A proxy: stars since creation, not stars gained today. */
  stars_per_day: number | null;
  html_url: string;
};
export type RepoDetail = Repo & { latest_release: string | null };

export type GithubError = "invalid_input" | "rate_limited" | "not_found" | "timeout" | "too_large" | "github_error";
export type GithubReply<T> = { ok: true; data: T } | { ok: false; error: GithubError; retry_after_s?: number };

export type SearchArgs = {
  query: string;
  sort: "stars" | "updated" | "forks";
  topic?: string;
  language?: string;
  limit?: number;
  /** YYYY-MM-DD, built into created:>=DATE. */
  created_after?: string;
  /** YYYY-MM-DD, built into pushed:>=DATE. */
  pushed_after?: string;
};

export type Github = {
  searchRepos(args: SearchArgs): Promise<GithubReply<{ repos: Repo[] }>>;
  getRepo(fullName: string): Promise<GithubReply<RepoDetail>>;
};

export type GithubOptions = {
  fetch?: typeof fetch;
  /** Optional read-only token. Sent only to api.github.com. */
  token?: string | undefined;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
};

const QUERY = /^[A-Za-z0-9 _.-]{1,120}$/; // no ":" so no qualifier can be written by the model
const TOPIC = /^[a-z0-9][a-z0-9-]{0,49}$/;
const LANGUAGE = /^[A-Za-z0-9+#.-]{1,30}$/;
// A segment made only of dots ("." or "..") would make the address climb out of /repos/, so it is refused.
export const FULL_NAME = /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const DAY_MS = 86_400_000;
const MAX_AGE_YEARS = 10;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date (2026-02-31 is not), not in the future, not older than 10 years. */
function validDate(d: unknown, nowMs: number): d is string {
  if (typeof d !== "string" || !DATE.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== d) return false;
  const oldest = new Date(nowMs);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_AGE_YEARS);
  oldest.setUTCHours(0, 0, 0, 0); // whole days: exactly 10 years ago is still allowed
  return ms <= nowMs && ms >= oldest.getTime();
}

const bad = { ok: false, error: "invalid_input" } as const;

export function createGithub(opts: GithubOptions = {}): Github {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const token = opts.token?.trim() || undefined;
  const cache = new Map<string, { at: number; value: unknown }>();
  let calls: number[] = []; // times of the calls made in the last minute

  /** One counted request. Returns the parsed JSON or a short error code. */
  async function call(path: string, params: Record<string, string>): Promise<GithubReply<unknown>> {
    const t = now();
    calls = calls.filter((c) => t - c < 60_000);
    if (calls.length >= MAX_CALLS_PER_MINUTE) {
      return { ok: false, error: "rate_limited", retry_after_s: Math.max(1, Math.ceil(((calls[0] ?? t) + 60_000 - t) / 1000)) };
    }
    calls.push(t);
    const url = new URL(`https://${GITHUB_HOST}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    log({ event: "github-call", path: path.split("/")[1] ?? "" });
    try {
      const res = await doFetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-office-3d",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "error", // the token must never follow a redirect to another host
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404) return { ok: false, error: "not_found" };
      if (res.status === 403 || res.status === 429) return { ok: false, error: "rate_limited", retry_after_s: 60 };
      if (!res.ok) return { ok: false, error: "github_error" };
      const body = await readCapped(res);
      if (body === null) return { ok: false, error: "too_large" };
      return { ok: true, data: JSON.parse(body) as unknown };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "github_error" };
    }
  }

  /** Cached answer within 10 minutes, else `make()`. Only successes are cached. */
  async function cached<T>(key: string, make: () => Promise<{ reply: GithubReply<T>; keep: boolean }>): Promise<GithubReply<T>> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return { ok: true, data: hit.value as T };
    const { reply, keep } = await make();
    if (reply.ok && keep) {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: now(), value: reply.data });
    }
    return reply;
  }

  return {
    async searchRepos(args) {
      const { query, sort, topic, language, created_after, pushed_after } = args;
      const limit = args.limit ?? MAX_LIMIT;
      if (typeof query !== "string" || !QUERY.test(query) || query.trim() === "") return bad;
      if (sort !== "stars" && sort !== "updated" && sort !== "forks") return bad;
      for (const d of [created_after, pushed_after]) if (d !== undefined && !validDate(d, now())) return bad;
      if (topic !== undefined && !TOPIC.test(topic)) return bad;
      if (language !== undefined && !LANGUAGE.test(language)) return bad;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return bad;
      // The only qualifiers are built here, from the validated values.
      const q = [query.trim(), topic ? `topic:${topic}` : "", language ? `language:${language}` : "", created_after ? `created:>=${created_after}` : "", pushed_after ? `pushed:>=${pushed_after}` : ""].filter(Boolean).join(" ");
      return cached(JSON.stringify(["search", q, sort, limit]), async () => {
        const reply = await call("/search/repositories", { q, sort, order: "desc", per_page: String(limit) });
        if (!reply.ok) return { reply, keep: false };
        const items = isRecord(reply.data) && Array.isArray(reply.data["items"]) ? (reply.data["items"] as unknown[]) : [];
        const repos = items.map((i) => toRepo(i, now())).filter((r): r is Repo => r !== null).slice(0, limit);
        return { reply: { ok: true, data: { repos } }, keep: true };
      });
    },

    async getRepo(fullName) {
      if (typeof fullName !== "string" || !FULL_NAME.test(fullName)) return bad;
      return cached(JSON.stringify(["repo", fullName.toLowerCase()]), async () => {
        const reply = await call(`/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`, {});
        if (!reply.ok) return { reply, keep: false };
        const repo = toRepo(reply.data, now());
        if (!repo) return { reply: { ok: false, error: "github_error" }, keep: false };
        const rel = await call(`/repos/${fullName.split("/").map(encodeURIComponent).join("/")}/releases/latest`, {});
        // No release (404) is normal. Any other failure still returns the repo, but is not cached.
        const tag = rel.ok && isRecord(rel.data) && typeof rel.data["tag_name"] === "string" ? rel.data["tag_name"].slice(0, 100) : null;
        return { reply: { ok: true, data: { ...repo, latest_release: tag } }, keep: rel.ok || rel.error === "not_found" };
      });
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

function toRepo(item: unknown, nowMs: number): Repo | null {
  if (!isRecord(item) || typeof item["full_name"] !== "string" || !FULL_NAME.test(item["full_name"])) return null;
  const license = isRecord(item["license"]) ? str(item["license"]["spdx_id"], 50) : null;
  const created = str(item["created_at"], 40);
  const createdMs = created ? Date.parse(created) : NaN;
  const stars = num(item["stargazers_count"]);
  return {
    full_name: item["full_name"],
    stars,
    forks: num(item["forks_count"]),
    open_issues: num(item["open_issues_count"]),
    // One line, no control characters, at most 200 characters.
    description: (str(item["description"], 2000) ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 200),
    topics: Array.isArray(item["topics"]) ? item["topics"].filter((t): t is string => typeof t === "string").slice(0, 20).map((t) => t.slice(0, 50)) : [],
    license,
    language: str(item["language"], 50),
    pushed_at: str(item["pushed_at"], 40),
    created_at: Number.isNaN(createdMs) ? null : new Date(createdMs).toISOString().slice(0, 10), // a plain date: nothing from GitHub's string passes through
    stars_per_day: Number.isNaN(createdMs) ? null : Math.round((stars / Math.max(1, (nowMs - createdMs) / DAY_MS)) * 10) / 10,
    html_url: `https://github.com/${item["full_name"]}`,
  };
}

/** The body as text, or null when it is larger than the cap. */
async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
