# Agent Office 3D

A local 3D workspace that shows Claude Code sessions and subagents as characters in a low-poly office.

Architecture and tickets live in the Obsidian vault under `agent-workspace/architecture/agent-office-3d/`.

## Run

Needs Node 24.12 or newer.

```sh
npm ci
npm run dev      # server on 4777, page on 5173
```

The terminal prints a **one-time URL**. Open it: the server swaps the token for a session cookie and sends you to the page. Restarting the server (including the dev auto-restart on a code change) invalidates the session, so open the new URL it prints.

For a production-style run: `npm run build`, then `npm start` (page and server both on 4777).

Settings can go in a `.env` file in the project folder (git-ignored), one `NAME=value` per line, for example `OFFICE_VAULT_DIR=C:\Users\you\Documents\Obsidian Vault`. Both `npm run dev` and `npm start` read it if it exists; variables already set in the terminal win. Do not put an API key there: workers never use one.

## Starting workers from the page

Needs Claude Code installed and logged in with your Claude subscription. Workers never use an API key: key and cloud-provider variables are removed from their environment, and a session that reports an API key source is ended.

A worker can read, search, edit and write files in its folder and search the web. It cannot run commands or fetch pages. By default it may only use the folder the server was started in; to allow others set `OFFICE_ALLOWED_ROOTS` (several folders separated by `;` on Windows, `:` elsewhere). `MAX_MANAGED` (default 8) limits how many run at once.

A **master** is a session started with "Start a master" that can also run workers of its own through five built-in tools (`spawn_worker`, `assign_task`, `wait_for_workers`, `stop_worker`, `list_workers`). It has the same lockdown as a worker; the tools run inside the server, not on a network port. It can only control the workers it started, a worker's folder must lie inside the master's own folder, and workers get no such tools. Stopping a master stops its workers. At most `MAX_MASTERS` (default 1) masters run at once, each with at most `MAX_WORKERS_PER_MASTER` (default 5) workers; a master counts toward `MAX_MANAGED`. A worker's result text (cut to 2000 characters) is kept in memory only. The usage caps count master and workers together.

Search results are untrusted text. A worker that can edit files could be steered by instructions hidden in them, so keep its folder to something you can restore.

## The office

Each session is a low-poly character at its own desk; the desk stays the same while the agent exists. Click a character or its list entry to select it. Open `/?demo` (or `/?demo=40` for 40 fake agents) to see the office without real sessions; demo mode never mixes with real ones and cannot start or stop anything.

## Browser checks

`node tools/browser/check-office.ts <output folder> shots narrow click reduced perf` starts the server and a headless Edge or Chrome (set `BROWSER_PATH` if it is elsewhere), then writes screenshots and prints frame rate, draw calls and console problems.

## Giving workers more work, limits, and restarts

A running worker takes one task at a time: use "Give a task" in its details panel (a second task while it is busy is refused). Workers that ended, errored or were left behind by a restart stay in the list; "Resume" continues the same conversation after you press it (nothing restarts by itself), "Dismiss" forgets the worker.

Usage limits (estimates reported by the SDK, they protect your plan's usage): about 2 per run, `OFFICE_SESSION_BUDGET_USD` (default 5) per session across resumes, `OFFICE_TOTAL_BUDGET_USD` (default 20) for all workers since the server started. A worker that reaches a limit is stopped and the page says why. When Claude reports a subscription rate limit the worker shows "Waiting" and is not retried.

The server keeps a small file `data/managed.json` (git-ignored; folder set with `OFFICE_DATA_DIR`) with each worker's name, folder, process id and cost. At startup it stops a leftover worker process only if its name and start time still match, then lists all stored workers as detached. Delete the file at any time to forget them.

## Checks


```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Security

The server listens on 127.0.0.1 only, rejects any request whose `Host` is not localhost, rejects POSTs whose `Origin` is not its own, and needs the session cookie for `/events` and `/api/*`.

Settings: `OFFICE_PORT` (default 4777), `OFFICE_PUBLIC_PORT` (browser port when a dev server proxies to this one), `OFFICE_ALLOWED_ROOTS`, `MAX_MANAGED` (default 8), `MAX_MASTERS` (default 1), `MAX_WORKERS_PER_MASTER` (default 5), `OFFICE_SESSION_BUDGET_USD`, `OFFICE_TOTAL_BUDGET_USD`, `OFFICE_DATA_DIR`, `OFFICE_STALE_MINUTES` (default 15), `CLAUDE_CONFIG_DIR` (where Claude Code keeps its logs).

## Obsidian vault

Set `OFFICE_VAULT_DIR` to a vault folder (absolute path) and the hub shows its note count, newest notes and a link graph. Only `.md` files inside that folder are read, never written; hidden folders (`.obsidian`, `.trash`, `.git`) and links that leave the folder are skipped. Only titles, relative paths, times and `[[link]]` targets reach the page, never note text. At most 5000 notes are scanned (files over 256 KB are not searched for links), and 200 notes and 1000 links are returned. The scan is cached for 30 s; `/api/vault?refresh=1` rescans, at most once every 5 s. Unset or invalid, the hub says no vault is connected.

## Live check

`OFFICE_LIVE_TESTS=1 node --test server/test/live.test.ts` starts a real worker in a temporary folder, to confirm the lockdown against the real Claude Agent SDK. It uses a little of your subscription, and each run leaves a small log folder under your Claude `projects` folder. Normal test runs and CI skip it.

## Research team

"Start a research team" (`POST /api/agents` with `role:"master"`, `team:"research"`, no `cwd`) starts a Research Lead that can start up to three researchers (repo-scout, skills-mcp-scout, integration-analyst) and writes one markdown report named `YYYY-MM-DD-<slug>.md` in the research folder. The team only recommends; it installs nothing.

- **Research folder:** `OFFICE_RESEARCH_DIR`, else `<OFFICE_VAULT_DIR>/agent-workspace/research` (created if missing). Only this folder is added to the allowed roots; the rest of the vault stays read-only to the app. The Lead's folder is this folder, a given `cwd` must lie inside it, and so must its researchers' folders. With neither variable set, starting a team answers `400 no_research_folder`.
- **GitHub tools:** only the researchers (never the Lead, ordinary workers or ordinary masters) get `mcp__github__github_search_repos` and `mcp__github__github_repo`. They run inside the server, talk only to `api.github.com` over https, return metadata only (no README or file contents), cache for 10 minutes and allow 8 GitHub calls a minute for the whole app (the answer is `{"error":"rate_limited","retry_after_s":N}`).
- **`GITHUB_TOKEN`** (optional, read-only, no scopes needed) in `.env` raises GitHub's own limit. It is sent only to `api.github.com`, removed from every worker's environment, and never appears in a tool result, log or event.
