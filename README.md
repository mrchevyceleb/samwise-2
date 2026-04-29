# Samwise — at your service

A web app that's a chat with your local Claude Code CLI. Runs on the Mac Mini,
reachable from any device over Tailscale.

## What it is

- Pick a repo from the threshold (or "Assistant" to land in `ASSISTANT-HUB`).
- Pick a companion (Claude Code, Codex (TBD), Assistant).
- Hit **Set forth**. You're in a chat with `claude` running in that repo.
- Conversations persist across browser closes, devices, and server restarts.

## Layout

```
samwise-2/
├── src/                   React + Vite frontend
├── server/                Node + Express + ws backend
├── scripts/               start.sh, install-launchd.sh, plist
└── README.md
```

## Develop

Two terminals:

```bash
# terminal 1 — backend (port 8090)
cd server && npm install && npm run dev

# terminal 2 — frontend (port 5173, proxies /api → 8090)
npm install && npm run dev
```

Open http://localhost:5173.

## Production (auto-start on the Mini)

```bash
./scripts/install-launchd.sh
```

That:
- builds `dist/` if needed
- copies `com.matt.samwise-2.plist` into `~/Library/LaunchAgents`
- loads the launchd job (auto-starts on login, auto-restarts on crash)
- exposes everything on port **8090**

After install, hit `http://localhost:8090` from this Mac, or
`http://<this-mac-tailscale-name>:8090` from any device on the tailnet.

Logs:
- `~/Library/Logs/samwise-2.log`
- `~/Library/Logs/samwise-2.err.log`

To uninstall: `./scripts/uninstall-launchd.sh`

## How it works

- **Frontend** is the Reading Room design (parchment palette, EB Garamond,
  threshold + conversation views, chronicle ribbon).
- **Backend** holds one persistent `claude -p --input-format stream-json
  --output-format stream-json --include-partial-messages
  --dangerously-skip-permissions` process per `(cli, repo)` pair. Stdin
  receives user turns as JSON, stdout streams events.
- **Sessions persist** via `~/.samwise-2/sessions.json` mapping `(cli, repo) →
  claude session_id`. On reconnect the manager resumes that session. If the
  session file is missing, it transparently retries without `--resume` and
  starts a fresh thread.
- **Repos discovered** from `~/code`, `~/samwise/Personal-Apps`,
  `~/Documents/PERSONAL-PROJECTS`, plus the pinned ASSISTANT-HUB.
- **Chronicle** scans `~/.claude/projects/<encoded-cwd>/*.jsonl` and surfaces
  recent sessions with their first user message as the title.

## Open work

- Codex companion (stubbed; `codex exec` event shape is different from claude
  stream-json, needs its own normalizer)
- Tailscale serve / HTTPS termination if you want a hostname instead of `:8090`
- Notifications when long turns finish
