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

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Security

The server listens on 127.0.0.1 only, rejects any request whose `Host` is not localhost, rejects POSTs whose `Origin` is not its own, and needs the session cookie for `/events` and `/api/*`.

Settings: `OFFICE_PORT` (default 4777), `OFFICE_PUBLIC_PORT` (browser port when a dev server proxies to this one).
