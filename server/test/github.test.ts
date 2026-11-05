import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGithub, MAX_BODY_BYTES, MAX_CALLS_PER_MINUTE } from "../src/github.ts";

const TOKEN = "ghp_SECRETTOKEN123";

const item = (name: string, extra: Record<string, unknown> = {}) => ({
  full_name: name,
  stargazers_count: 1234,
  forks_count: 56,
  open_issues_count: 7,
  description: "A  tool\nwith\ttabs " + "x".repeat(400),
  topics: ["mcp-server", "ai"],
  license: { spdx_id: "MIT", name: "MIT License", url: "https://x" },
  language: "TypeScript",
  pushed_at: "2026-10-01T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
  html_url: "https://evil.example/" + name,
  owner: { login: "o" },
  secret_extra: "nope",
  ...extra,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A scripted GitHub: records every request and answers from a function. */
function scripted(answer: (url: URL) => Response | Promise<Response> = () => json({ items: [item("a/b")] })) {
  const requests: { url: URL; headers: Record<string, string>; init: RequestInit }[] = [];
  const fetchFn = (async (input: URL, init: RequestInit) => {
    requests.push({ url: input, headers: init.headers as Record<string, string>, init });
    return answer(input);
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

const search = (query = "mcp servers") => ({ query, sort: "stars" as const });

describe("GitHub client: fields and validation (R1)", () => {
  it("returns only the listed fields, with a one-line description cut to 200 characters", async () => {
    const g = scripted();
    const res = await createGithub({ fetch: g.fetchFn }).searchRepos({ ...search(), topic: "mcp-server", language: "C#", limit: 3 });
    assert.ok(res.ok);
    const repo = res.data.repos[0]!;
    assert.deepEqual(Object.keys(repo).sort(), ["description", "forks", "full_name", "html_url", "language", "license", "open_issues", "pushed_at", "created_at", "stars", "stars_per_day", "topics"].sort());
    assert.equal(repo.stars, 1234);
    assert.equal(repo.license, "MIT");
    assert.equal(repo.html_url, "https://github.com/a/b");
    assert.equal(repo.description.length, 200);
    assert.ok(!/[\n\t]|\s\s/.test(repo.description));
    const q = g.requests[0]!.url.searchParams;
    assert.equal(q.get("q"), "mcp servers topic:mcp-server language:C#");
    assert.equal(q.get("sort"), "stars");
    assert.equal(q.get("per_page"), "3");
  });

  it("rejects odd input before any request", async () => {
    const g = scripted();
    const gh = createGithub({ fetch: g.fetchFn });
    const bad = [
      { ...search("stars:>1000") },
      { ...search("user:someone") },
      { ...search('"quoted"') },
      { ...search("x".repeat(121)) },
      { ...search("   ") },
      { ...search(), topic: "a b" },
      { ...search(), topic: "x language:Go" },
      { ...search(), language: "Go stars:>5" },
      { ...search(), limit: 11 },
      { ...search(), limit: 0 },
      { ...search(), sort: "watchers" as never },
    ];
    for (const args of bad) assert.deepEqual(await gh.searchRepos(args), { ok: false, error: "invalid_input" }, JSON.stringify(args));
    for (const name of ["noslash", "a/b/c", "a/b?x=1", "../x/y", "../user", "../..", "a/..", "./x", "a/.", "../", "a/" + "b".repeat(101), "a b/c"]) {
      assert.deepEqual(await gh.getRepo(name), { ok: false, error: "invalid_input" }, name);
    }
    assert.equal(g.requests.length, 0);
  });

  it("getRepo adds the latest release tag with one extra call and tolerates a missing release", async () => {
    const g = scripted((url) => (url.pathname.endsWith("/releases/latest") ? json({ tag_name: "v1.2.3", body: "notes" }) : json(item("a/b"))));
    const res = await createGithub({ fetch: g.fetchFn }).getRepo("a/b");
    assert.ok(res.ok);
    assert.equal(res.data.latest_release, "v1.2.3");
    assert.equal(g.requests.length, 2);
    assert.ok(!("secret_extra" in res.data) && !("owner" in res.data));

    const none = scripted((url) => (url.pathname.endsWith("/releases/latest") ? json({}, 404) : json(item("a/b", { license: null }))));
    const res2 = await createGithub({ fetch: none.fetchFn }).getRepo("a/b");
    assert.ok(res2.ok);
    assert.equal(res2.data.latest_release, null);
    assert.equal(res2.data.license, null);
  });
});

describe("GitHub client: host, cache, limit, token (R2)", () => {
  it("talks only to https://api.github.com and never follows redirects", async () => {
    const g = scripted((url) => (url.pathname.startsWith("/repos") ? json(item("a/b")) : json({ items: [] })));
    const gh = createGithub({ fetch: g.fetchFn, token: TOKEN });
    await gh.searchRepos(search());
    await gh.getRepo("a/b");
    assert.equal(g.requests.length, 3);
    for (const r of g.requests) {
      assert.equal(r.url.protocol, "https:");
      assert.equal(r.url.host, "api.github.com");
      assert.equal(r.init.redirect, "error");
      assert.ok(r.init.signal, "has a timeout");
    }
  });

  it("answers the same request from the cache for 10 minutes", async () => {
    let t = 1_000_000;
    const g = scripted();
    const gh = createGithub({ fetch: g.fetchFn, now: () => t });
    await gh.searchRepos(search());
    t += 9 * 60_000;
    await gh.searchRepos(search());
    assert.equal(g.requests.length, 1);
    t += 2 * 60_000;
    await gh.searchRepos(search());
    assert.equal(g.requests.length, 2);
  });

  it("allows 8 calls a minute for the whole app, then answers rate_limited with a wait time", async () => {
    let t = 5_000_000;
    const g = scripted();
    const gh = createGithub({ fetch: g.fetchFn, now: () => t });
    for (let i = 0; i < MAX_CALLS_PER_MINUTE; i++) assert.ok((await gh.searchRepos(search(`topic ${i}`))).ok);
    t += 20_000;
    const res = await gh.searchRepos(search("one more"));
    assert.deepEqual(res, { ok: false, error: "rate_limited", retry_after_s: 40 });
    assert.equal(g.requests.length, 8);
    assert.ok((await gh.searchRepos(search("topic 0"))).ok, "a cached answer needs no call");
    t += 41_000;
    assert.ok((await gh.searchRepos(search("one more"))).ok);
  });

  it("sends the token only as the Authorization header, and it appears in no result, error or log", async () => {
    const logs: Record<string, unknown>[] = [];
    const replies: Response[] = [
      json({ items: [item("a/b")] }),
      new Response(`server said ${TOKEN}`, { status: 500 }),
      json({ message: `bad credentials ${TOKEN}` }, 403),
    ];
    const g = scripted(() => replies.shift()!);
    const gh = createGithub({ fetch: g.fetchFn, token: TOKEN, log: (l) => logs.push(l) });
    const results = [await gh.searchRepos(search("a")), await gh.searchRepos(search("b")), await gh.searchRepos(search("c"))];
    assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.error)), ["ok", "github_error", "rate_limited"]);
    for (const r of g.requests) assert.equal(r.headers["Authorization"], `Bearer ${TOKEN}`);
    for (const r of g.requests) {
      const rest = { ...r.headers, Authorization: "" };
      assert.ok(!JSON.stringify([r.url.href, rest]).includes(TOKEN), "the token is in no other header or in the URL");
    }
    assert.ok(!JSON.stringify([results, logs]).includes(TOKEN));
    // Without a token there is no header at all.
    const g2 = scripted();
    await createGithub({ fetch: g2.fetchFn }).searchRepos(search());
    assert.ok(!("Authorization" in g2.requests[0]!.headers));
  });

  it("turns a failure, a timeout and an oversized answer into short codes", async () => {
    const boom = createGithub({ fetch: (async () => { throw new Error(`connect failed ${TOKEN}`); }) as unknown as typeof fetch, token: TOKEN });
    assert.deepEqual(await boom.searchRepos(search()), { ok: false, error: "github_error" });
    const slow = createGithub({ fetch: (async () => { throw new DOMException("t", "TimeoutError"); }) as unknown as typeof fetch });
    assert.deepEqual(await slow.searchRepos(search()), { ok: false, error: "timeout" });
    const big = scripted(() => new Response("x".repeat(MAX_BODY_BYTES + 1)));
    assert.deepEqual(await createGithub({ fetch: big.fetchFn }).searchRepos(search()), { ok: false, error: "too_large" });
    const missing = scripted(() => json({}, 404));
    assert.deepEqual(await createGithub({ fetch: missing.fetchFn }).getRepo("a/b"), { ok: false, error: "not_found" });
  });
});

describe("GitHub client: recently popular proxies", () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const gh = (g: ReturnType<typeof scripted>) => createGithub({ fetch: g.fetchFn, now: () => NOW });

  it("rejects bad, impossible, future, too old and injected dates with no request", async () => {
    const g = scripted();
    const c = gh(g);
    const dates = ["2026/01/01", "26-01-01", "2026-1-1", "2026-02-31", "2026-13-01", "2026-11-06", "2027-01-01", "2016-11-04", "2026-01-01 stars:>1", "2026-01-01\n", " 2026-01-01", "", "20260101"];
    for (const d of dates) {
      for (const key of ["created_after", "pushed_after"] as const) {
        assert.deepEqual(await c.searchRepos({ ...search(), [key]: d }), { ok: false, error: "invalid_input" }, `${key} ${JSON.stringify(d)}`);
      }
    }
    assert.deepEqual(await c.searchRepos({ ...search(), created_after: 20260101 as never }), { ok: false, error: "invalid_input" });
    assert.equal(g.requests.length, 0);
  });

  it("builds the qualifiers exactly and accepts today and the 10-year edge", async () => {
    const g = scripted();
    const c = gh(g);
    assert.ok((await c.searchRepos({ ...search("mcp"), topic: "mcp-server", created_after: "2026-10-06", pushed_after: "2026-11-05" })).ok);
    assert.equal(g.requests[0]!.url.searchParams.get("q"), "mcp topic:mcp-server created:>=2026-10-06 pushed:>=2026-11-05");
    assert.ok((await c.searchRepos({ ...search("old"), created_after: "2016-11-05" })).ok);
  });

  it("accepts sort=forks and passes it on", async () => {
    const g = scripted();
    assert.ok((await gh(g).searchRepos({ query: "x", sort: "forks" })).ok);
    assert.equal(g.requests[0]!.url.searchParams.get("sort"), "forks");
  });

  it("computes stars_per_day: age 0, under one day, rounding, and a missing date", async () => {
    const day = 86_400_000;
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    const g = scripted(() =>
      json({
        items: [
          item("a/zero", { stargazers_count: 50, created_at: at(0) }),
          item("a/half", { stargazers_count: 50, created_at: at(day / 2) }),
          item("a/ten", { stargazers_count: 100, created_at: at(10 * day) }),
          item("a/third", { stargazers_count: 10, created_at: at(3 * day) }),
          item("a/none", { created_at: undefined }),
          item("a/junk", { created_at: "not a date" }),
        ],
      }),
    );
    const res = await gh(g).searchRepos(search());
    assert.ok(res.ok);
    assert.deepEqual(res.data.repos.map((r) => r.stars_per_day), [50, 50, 10, 3.3, null, null]);
    assert.equal(res.data.repos[2]!.created_at, at(10 * day).slice(0, 10));
    assert.equal(res.data.repos[4]!.created_at, null);
  });

  it("getRepo has created_at and stars_per_day and nothing else new", async () => {
    const g = scripted((url) => (url.pathname.endsWith("/releases/latest") ? json({}, 404) : json(item("a/b", { stargazers_count: 30, created_at: new Date(NOW - 4 * 86_400_000).toISOString() }))));
    const res = await gh(g).getRepo("a/b");
    assert.ok(res.ok);
    assert.equal(res.data.stars_per_day, 7.5);
    assert.deepEqual(Object.keys(res.data).sort(), ["created_at", "description", "forks", "full_name", "html_url", "language", "latest_release", "license", "open_issues", "pushed_at", "stars", "stars_per_day", "topics"]);
  });

  it("does not share a cache entry between different date filters or sorts", async () => {
    const g = scripted();
    const c = gh(g);
    await c.searchRepos({ ...search(), created_after: "2026-10-01" });
    await c.searchRepos({ ...search(), created_after: "2026-10-02" });
    await c.searchRepos({ ...search(), pushed_after: "2026-10-01" });
    await c.searchRepos({ ...search(), created_after: "2026-10-01" });
    await c.searchRepos({ query: "mcp servers", sort: "forks", created_after: "2026-10-01" });
    assert.equal(g.requests.length, 4, "the repeat is cached, the rest are separate");
  });
});

describe("the shared repository name rule", () => {
  it("accepts ordinary names and refuses names that would climb out of the repository address", async () => {
    const { FULL_NAME } = await import("../src/github.ts");
    for (const ok of ["owner/name", "a.b/c-d_e", "..x/y", "x/.y", "x/y.."]) assert.ok(FULL_NAME.test(ok), ok);
    for (const bad of ["../user", "../..", "a/..", "./x", "a/.", "../", "a/b/c", ""]) assert.equal(FULL_NAME.test(bad), false, bad);
    assert.equal(new URL("https://api.github.com/repos/" + "owner/name".split("/").map(encodeURIComponent).join("/")).pathname, "/repos/owner/name");
  });
});
