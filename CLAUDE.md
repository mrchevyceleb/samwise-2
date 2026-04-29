# CLAUDE.md — samwise-2

You're working inside **samwise-2**: Matt's personal web app for chatting with
the Claude Code CLI from any device. This file is loaded automatically when
`claude` runs with a cwd inside this repo. Read it before doing anything.

## What this app is (in one paragraph)

A React/Vite frontend (the "Reading Room" — parchment palette, EB Garamond,
literary chat UI) that talks over WebSocket to a Node/Express server. The
server holds one persistent `claude -p --input-format stream-json
--output-format stream-json --include-partial-messages
--dangerously-skip-permissions` child process per `(companion, repo)` pair.
Stdin gets user turns as JSON. Stdout streams structured events that the
client renders as chat bubbles, tool call cards, and (eventually) diffs.
Sessions persist across browser closes, devices, and server restarts via
a tiny `~/.samwise-2/sessions.json` map. Auto-starts on the Mac Mini at boot
via a launchd plist; reachable from any device over Tailscale.

This is **not** Samwise the autonomous queue (that lives at
`~/samwise/Personal-Apps/Samwise`). This is Mac Mini Sam — manual chat only,
deliberately scoped small. If you find yourself adding a kanban, a state
machine, or a closeout pipeline, stop and check whether the work belongs in
the other Samwise instead.

## Tree

```
samwise-2/
├── src/                              React frontend (Vite + TS)
│   ├── App.tsx                       view state + mobile/desktop split
│   ├── components/
│   │   ├── primitives/               atoms (SamPortrait, Chip, ToolCall, ChatInput, …)
│   │   ├── desktop/                  Threshold, Conversation, ChronicleRibbon
│   │   └── mobile/                   MobileThreshold, MobileConversation, MobileChronicleSheet
│   ├── hooks/
│   │   ├── useChat.ts                WebSocket lifecycle + pure event reducer
│   │   ├── useChronicle.ts           polls /api/chronicle
│   │   ├── useMediaQuery.ts          isMobile breakpoint
│   │   └── useRepos.ts               fetches /api/repos
│   ├── data/
│   │   ├── types.ts                  shared types (CompanionId, Repo, ChatBlock)
│   │   └── mock.ts                   COMPANIONS, HUBS, ASSISTANT_HUB constants
│   ├── tokens.css                    parchment palette + fonts (sourced from design)
│   └── index.css                     base reset
├── server/                           Node + Express + ws backend
│   ├── src/
│   │   ├── index.ts                  HTTP routes + WS handler + static-serve in prod
│   │   ├── runner.ts                 ClaudeSession class + session manager
│   │   ├── repos.ts                  repo discovery (~/code, ~/samwise/Personal-Apps, …)
│   │   ├── chronicle.ts              reads ~/.claude/projects/*.jsonl
│   │   ├── sessions.ts               persists (cli,cwd) → claude session_id
│   │   └── config.ts                 PORT, scan paths, ASSISTANT-HUB path
│   └── package.json                  express + ws + tsx
├── scripts/
│   ├── start.sh                      production entrypoint (build + start)
│   ├── install-launchd.sh            one-time install of the launchd job
│   ├── uninstall-launchd.sh
│   └── com.matt.samwise-2.plist      launchd job definition
├── vite.config.ts                    proxies /api → :8090 in dev
└── README.md
```

## How to run

**Dev** (two terminals):
```
cd server && npm run dev    # :8090
npm run dev                 # :5173 — Vite, proxies /api → :8090
```

**Production** (autostarts on Mini):
```
./scripts/install-launchd.sh
```
Reach it at `http://localhost:8090` or `http://<tailscale-name>:8090`.

## Architecture deep dive

### The persistent CLI process (`server/src/runner.ts`)

`ClaudeSession` wraps one long-lived `claude -p` invocation. Stdin: JSON
user turns (`{"type":"user","message":{"role":"user","content":"…"}}\n`).
Stdout: claude's stream-json events, JSONL.

Key behaviours:
- **One process per `(cli, repo)` pair.** Indexed in a `Map<string, ClaudeSession>`
  by `${cli}|${cwd}`. Lazy-spawned, never per-turn (kills the 2-3s startup tax).
- **Survives WS disconnects.** Closing the browser doesn't shut down the
  process. The next reconnect re-subscribes to the same one.
- **Silent-resume-failure recovery.** When `--resume <missing-id>` makes
  claude exit before init, `spawnSession` detects it (the `ready` promise
  resolves `false`), drops the stale id from disk, and retries once without
  `--resume`. The user never sees a hang.
- **Persistence.** `setSessionId(cli, cwd, sessionId)` writes
  `~/.samwise-2/sessions.json` whenever the init event arrives. On the next
  cold start the manager resumes that id.

### The frontend reducer (`src/hooks/useChat.ts`)

Stream-json events are reduced into `ChatBlock[]`. The reducer is **pure**
because React Strict Mode runs reducers twice — any out-of-band mutable map
(like the one I tried first) gets corrupted. Block-to-event correlation lives
on the blocks themselves: each text or tool block carries `turnId` (set from
`message_start`) and `cbIndex` (the claude content_block index). Deltas find
their target by matching both.

Event handling:
- `stream_event` wrapping recurses into the inner event
- `message_start` → mints a new `turnId`, closes any prior `open` blocks
- `content_block_start` → creates an empty text or tool block with `(turnId, cbIndex, open: true)`
- `content_block_delta` (`text_delta` | `input_json_delta`) → appends into the matching block
- `content_block_stop` → closes the block; tool args get JSON-prettified
- `user` event with `tool_result` content → updates the matching tool block's `result`
- final `assistant` event → ignored (canonical content already accumulated via deltas)

If you change this, keep it pure. If you need transient state, store it on
the blocks themselves; do not add a Map ref outside the state tree.

### The WS protocol (`server/src/index.ts`)

Client → server:
- `{type: "hello", cli, repo}` — open or attach to the session for this pair
- `{type: "send", text}` — write a user turn into the live process

Server → client:
- `{type: "ready", cli, repo}` — session is up
- `{type: "turnStart"}` — server received your `send`, working on it
- `{type: "stream", event}` — pass-through claude stream-json event
- `{type: "turnEnd", sessionId}` — `result` event arrived from claude
- `{type: "error", message}` — soft error (chat continues)
- `{type: "sessionClosed", code}` — the process exited

### Repo discovery (`server/src/repos.ts`)

Scans these parents for first-level dirs containing `.git`:
- `~/code`
- `~/samwise/Personal-Apps`
- `~/Documents/PERSONAL-PROJECTS`

Plus pins `ASSISTANT_HUB_PATH` first (the OneDrive-Personal/.../ASSISTANT-HUB
path). Each repo gets its `name`, `branch`, and `hub` (parent dir basename).

### Chronicle (`server/src/chronicle.ts`)

Lists recent claude sessions by walking `~/.claude/projects/<encoded-cwd>/`.
Encoded path is `replaceAll('/', '-')`, which is lossy when paths contain
dashes (like `OneDrive-Personal` or `ASSISTANT-HUB`). To recover real paths
we reverse-lookup against `discoverRepos()`. For sessions whose cwd we don't
know, we fall back to the (lossy) decode.

The chronicle endpoint extracts a title from the **first interesting** user
message in each session JSONL. Lines starting with `<` (IDE markers,
command-message tags) and `You are` (claude-internal system prompts) are
skipped.

## Conventions

- **No em dashes in user-facing strings**, anywhere. Use `,` or `.` or `()`.
  (Em dashes in code comments and this doc are fine.)
- **Inline styles, not Tailwind.** The whole app uses inline style objects
  with CSS variables from `tokens.css`. Don't introduce a styling lib.
- **No new files for tiny things.** Add to an existing file unless you're
  introducing a genuinely new concept.
- **Stay terse.** This is Matt's personal app, not a public product.

## Don't

- Don't add a database. The CLI persists its own session JSONL files; we
  persist a tiny id map. That's enough.
- Don't add user accounts or auth. Tailscale is the auth boundary.
- Don't introduce a styling library, a state library, or any framework
  besides React + Vite + Express + ws.
- Don't rebuild Samwise (the autonomous queue) inside this app. They are
  separate by design. If something feels like it belongs in a kanban, it
  probably belongs in the other Samwise.
- Don't break the persistent-process invariant. Per-turn spawn is what we
  moved away from after looking at Banana IDE. Keep the warm process.

## Open work (in priority order)

1. **Codex companion.** Currently stubbed — `runTurn` throws for `cli ===
   'codex'`. Codex's event shape is meaningfully different (`thread.started`,
   `item.started/completed` for `agent_message` and `command_execution`
   items) so it needs its own session class and event normalizer. Probably
   spawn-per-turn (codex doesn't have a stdin-streaming mode that I found).
2. **Tailscale serve / HTTPS hostname.** Right now you reach this on
   `:8090`. Setting up `tailscale serve` would give it a real HTTPS hostname.
3. **Push notifications when long turns finish.** Telegram bot is the
   obvious channel (already integrated in `assistant-mcp`).
4. **Better repo decoding.** The chronicle's path reverse-lookup only
   covers repos discoverRepos() finds. Sessions in repos we don't scan show
   up under their lossy decoded names.

## When you make changes

- Frontend changes: `npm run dev` + check at http://localhost:5173. Use
  the playwright MCP to take screenshots if you want to verify visual.
- Server changes: `cd server && npm run dev` (tsx watch). Be aware that
  saving a server file restarts the process and kills any open WebSocket;
  the frontend will auto-reconnect within ~1s.
- Always typecheck: `npx tsc --noEmit` from each package root.
- Always run a production build before committing meaningful changes:
  `npm run build` (frontend) — catches TS errors that watch mode can hide.
- If you touch `runner.ts`, `useChat.ts`, or the WS protocol, end-to-end
  smoke-test by sending a real message through the Assistant companion.
