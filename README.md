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

## Starting workers from the page

Needs Claude Code installed and logged in with your Claude subscription. Workers never use an API key: key and cloud-provider variables are removed from their environment, and a session that reports an API key source is ended.

A worker can read, search, edit and write files in its folder and search the web. It cannot run commands or fetch pages. By default it may only use the folder the server was started in; to allow others set `OFFICE_ALLOWED_ROOTS` (several folders separated by `;` on Windows, `:` elsewhere). `MAX_MANAGED` (default 6) limits how many run at once.

Search results are untrusted text. A worker that can edit files could be steered by instructions hidden in them, so keep its folder to something you can restore.

## The office

Each session is a low-poly character at its own desk; the desk stays the same while the agent exists. Click a character or its list entry to select it. Open `/?demo` (or `/?demo=40` for 40 fake agents) to see the office without real sessions; demo mode never mixes with real ones and cannot start or stop anything.

## Browser checks

`node tools/browser/check-office.ts <output folder> shots narrow click reduced perf` starts the server and a headless Edge or Chrome (set `BROWSER_PATH` if it is elsewhere), then writes screenshots and prints frame rate, draw calls and console problems.

## Checks


```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Security

The server listens on 127.0.0.1 only, rejects any request whose `Host` is not localhost, rejects POSTs whose `Origin` is not its own, and needs the session cookie for `/events` and `/api/*`.

Settings: `OFFICE_PORT` (default 4777), `OFFICE_PUBLIC_PORT` (browser port when a dev server proxies to this one), `OFFICE_ALLOWED_ROOTS`, `MAX_MANAGED`, `OFFICE_STALE_MINUTES` (default 15), `CLAUDE_CONFIG_DIR` (where Claude Code keeps its logs).

## Live check

`OFFICE_LIVE_TESTS=1 node --test server/test/live.test.ts` starts a real worker in a temporary folder, to confirm the lockdown against the real Claude Agent SDK. It uses a little of your subscription, and each run leaves a small log folder under your Claude `projects` folder. Normal test runs and CI skip it.
