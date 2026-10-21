import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatBlock, CompanionId, Repo } from '../data/types';
import { contextWindowForCodexModel } from '../components/primitives/codexModels';

type Status = 'idle' | 'connecting' | 'ready' | 'streaming' | 'closed' | 'error';

export type ContextUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  outputTokens: number;
  /** How full the context window is, 0..1. */
  fraction: number;
  /** Window size in tokens (claude default). */
  windowTokens: number;
};

const DEFAULT_WINDOW_TOKENS = 200_000;
const LARGE_WINDOW_TOKENS = 1_000_000;
// Banana runs OpenRouter models; 200k is a sane default that covers most
// current models (the meter self-grows to 1M if a turn ever reports more).
const BANANA_WINDOW_TOKENS = 200_000;

function defaultWindowForCli(cli: CompanionId, model?: string): number {
  if (cli === 'codex') return contextWindowForCodexModel(model);
  if (cli === 'banana') return BANANA_WINDOW_TOKENS;
  return DEFAULT_WINDOW_TOKENS;
}

function windowForClaudeModel(model: string | undefined): number {
  if (!model) return DEFAULT_WINDOW_TOKENS;
  const m = model.toLowerCase();
  if (m.includes('[1m]') || m.includes('-1m')) return LARGE_WINDOW_TOKENS;
  return DEFAULT_WINDOW_TOKENS;
}

let nextId = 1;
const id = () => `b${nextId++}`;

// Pure reducer — all per-turn state lives on the blocks themselves
// (turnId + cbIndex). This keeps it safe under React Strict Mode, which
// invokes reducers twice for purity-checking.
function reduce(
  blocks: ChatBlock[],
  ev: any,
  turnIdRef: { current: string },
  /** Event time from the server envelope. Replayed history keeps the moment
   *  each event was emitted instead of restamping it at page load. */
  eventTs?: number,
): ChatBlock[] {
  const t = typeof eventTs === 'number' ? eventTs : Date.now();
  if (!ev || typeof ev !== 'object') return blocks;

  if (ev.type === 'stream_event' && ev.event) {
    return reduce(blocks, ev.event, turnIdRef, eventTs);
  }

  // Server-injected echo of the user's prompt — keeps the user's message in
  // the visible thread when a client reconnects and replays the buffer.
  if (ev.type === '_user_echo' && typeof ev.text === 'string') {
    // Dedupe: if the optimistic local user block was already added by send(),
    // don't double up.
    const lastUser = [...blocks].reverse().find((b) => b.kind === 'user');
    if (lastUser && lastUser.kind === 'user' && lastUser.text === ev.text) {
      return blocks;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
    return [...blocks, { kind: 'user', id: id(), text: ev.text, ts }];
  }

  if (ev.type === 'message_start') {
    // New assistant turn. Mint a fresh turnId; close out any open blocks from
    // a prior turn so their cbIndex correlation can no longer match.
    turnIdRef.current = `t${nextId++}`;
    return blocks.map((b) =>
      b.kind === 'user' ? b : 'open' in b && b.open ? { ...b, open: false } : b,
    );
  }

  if (ev.type === 'content_block_start') {
    const idx: number = ev.index;
    const cb = ev.content_block;
    const turnId = turnIdRef.current;
    if (cb?.type === 'text') {
      const block: ChatBlock = {
        kind: 'text', id: id(), text: '', ts: t,
        turnId, cbIndex: idx, open: true,
      };
      return [...blocks, block];
    }
    if (cb?.type === 'tool_use') {
      const block: ChatBlock = {
        kind: 'tool', id: id(),
        toolUseId: cb.id, tool: cb.name, args: '',
        running: true, ts: t,
        turnId, cbIndex: idx, open: true,
      };
      return [...blocks, block];
    }
    return blocks;
  }

  if (ev.type === 'content_block_delta') {
    const idx: number = ev.index;
    const turnId = turnIdRef.current;
    const delta = ev.delta;
    return blocks.map((b) => {
      if (b.kind === 'user') return b;
      if (!('cbIndex' in b) || b.cbIndex !== idx || b.turnId !== turnId || !b.open) return b;
      if (delta?.type === 'text_delta' && b.kind === 'text' && typeof delta.text === 'string') {
        return { ...b, text: b.text + delta.text };
      }
      if (delta?.type === 'input_json_delta' && b.kind === 'tool' && typeof delta.partial_json === 'string') {
        return { ...b, args: b.args + delta.partial_json };
      }
      return b;
    });
  }

  if (ev.type === 'content_block_stop') {
    const idx: number = ev.index;
    const turnId = turnIdRef.current;
    return blocks.map((b) => {
      if (b.kind === 'user') return b;
      if (!('cbIndex' in b) || b.cbIndex !== idx || b.turnId !== turnId) return b;
      if (b.kind === 'tool') {
        // Interactive tools need their full JSON args so the answer card can
        // parse `question`/`options`/`plan`. Prettifying truncates and turns
        // the JSON into a `key=value` summary string we can't rehydrate.
        const keepRaw = isInteractiveTool(b.tool);
        return { ...b, args: keepRaw ? b.args : prettifyJson(b.args), open: false };
      }
      return { ...b, open: false };
    });
  }

  // Tool result: claude emits a `user` message containing tool_result content.
  if (ev.type === 'user' && ev.message?.content) {
    let next = blocks;
    for (const c of ev.message.content as Array<any>) {
      if (c?.type === 'tool_result') {
        const summary = stringifyResult(c.content);
        next = next.map((b) =>
          b.kind === 'tool' && b.toolUseId === c.tool_use_id
            ? { ...b, result: summary, running: false, answered: true }
            : b,
        );
      }
    }
    return next;
  }

  // Server-injected echo of a user reply to an interactive tool (answer card
  // for AskUserQuestion / ExitPlanMode). Mark the matching tool block as
  // answered so the card collapses; the model's continuation will arrive as
  // the tool_result echo above shortly after.
  if (ev.type === '_tool_response' && typeof ev.toolUseId === 'string') {
    const reply = typeof ev.content === 'string' ? ev.content : '';
    return blocks.map((b) =>
      b.kind === 'tool' && b.toolUseId === ev.toolUseId
        ? { ...b, answered: true, answer: reply, running: false }
        : b,
    );
  }

  // Final `assistant` event: with content_block_* coverage above we already
  // have everything. Skip.

  return blocks;
}

/** Tools that need the user (or the UI) to respond with a tool_result before
 *  the model can advance the turn. The reducer keeps their raw JSON args so
 *  the answer card can render the question/options/plan. */
export function isInteractiveTool(name: string): boolean {
  return name === 'AskUserQuestion' || name === 'ExitPlanMode';
}

function prettifyJson(raw: string): string {
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const entries = Object.entries(obj as Record<string, unknown>);
      if (entries.length === 0) return '';
      return entries
        .slice(0, 3)
        .map(([k, v]) => {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
        })
        .join(' ');
    }
    return raw;
  } catch {
    return raw.length > 60 ? raw.slice(0, 60) + '…' : raw;
  }
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return summarize(content);
  if (Array.isArray(content)) {
    const text = content
      .map((c: any) => (c?.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join(' ');
    return summarize(text);
  }
  return '';
}

function summarize(s: string): string {
  const trimmed = s.trim();
  const firstLine = trimmed.split('\n')[0];
  if (trimmed.length <= 80) return trimmed;
  return `${firstLine.slice(0, 80)}…`;
}

function conversationKey(cli: CompanionId, repoPath: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return `${cli}|${repoPath}|chat:${normalized}`;
}

function sessionKey(cli: CompanionId, repoPath: string, chatId = 'main'): string {
  const normalized = chatId || 'main';
  return normalized === 'main' ? `${cli}|${repoPath}` : `${cli}|${repoPath}|${normalized}`;
}

function blocksStorageKey(cli: CompanionId, repoPath: string, chatId = 'main'): string {
  return `samwise-2:v2:blocks:${conversationKey(cli, repoPath, chatId)}`;
}

function readStoredBlocks(cli: CompanionId, repoPath: string, chatId = 'main'): ChatBlock[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(blocksStorageKey(cli, repoPath, chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ChatBlock[];
  } catch {}
  return [];
}

function writeStoredBlocks(
  cli: CompanionId,
  repoPath: string,
  blocks: ChatBlock[],
  chatId = 'main',
): void {
  if (typeof window === 'undefined') return;
  try {
    // Cap stored blocks so localStorage doesn't grow unbounded. Strip image
    // base64 payloads from user blocks: thumbnails render from in-memory state
    // during a session, but persisting hundreds of KB per screenshot quickly
    // blows past the ~5MB localStorage quota and silently breaks all future
    // writes (including non-image text blocks).
    const tail = blocks.slice(-200).map((b) => {
      if (b.kind === 'user' && b.images && b.images.length) {
        const { images, ...rest } = b;
        return rest;
      }
      return b;
    });
    localStorage.setItem(blocksStorageKey(cli, repoPath, chatId), JSON.stringify(tail));
  } catch {}
}

function readStoredSeq(cli: CompanionId, repoPath: string, chatId = 'main'): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(blocksStorageKey(cli, repoPath, chatId) + ':seq');
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  } catch {}
  return 0;
}

function writeStoredSeq(
  cli: CompanionId,
  repoPath: string,
  seq: number,
  chatId = 'main',
): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(blocksStorageKey(cli, repoPath, chatId) + ':seq', String(seq));
  } catch {}
}

export function useChat(opts: {
  repo: Repo | undefined;
  cli: CompanionId;
  chatId?: string;
  enabled: boolean;
  initialMessage?: string | null;
  onInitialMessageSent?: () => void;
  /** Model id for the spawn-per-turn Banana and Codex runners. */
  model?: string;
  /** Codex reasoning effort. Ignored by Claude and Banana. */
  effort?: string;
  /** The model + effort a live Claude/assistant session was spawned with.
   *  Lets the picker follow the session across devices instead of showing
   *  this browser's stored choice. */
  onSessionSelection?: (
    model: string,
    effort?: string,
  ) => { model: string; effort: string } | null;
}) {
  const { repo, cli, chatId = 'main', enabled, initialMessage, onInitialMessageSent, model, effort, onSessionSelection } = opts;
  // Mirror the selection before paint so a send/steer event can never observe
  // the prior render's pair after the picker already shows the new values.
  const selectionRef = useRef<{ model?: string; effort?: string }>({ model, effort });
  useLayoutEffect(() => {
    selectionRef.current = { model, effort };
  }, [model, effort]);
  const modelField = useCallback((): { model?: string; effort?: string } => {
    const selection = selectionRef.current;
    if (cli === 'banana' && selection.model) return { model: selection.model };
    // `assistant` is the hub lane running the Claude CLI, so it takes the
    // Claude model/effort pair exactly like `claude` does.
    if (
      (cli === 'codex' || cli === 'claude' || cli === 'assistant')
      && selection.model && selection.effort
    ) {
      return { model: selection.model, effort: selection.effort };
    }
    return {};
  }, [cli]);
  // Blocks and the conversation key they belong to live in a single state
  // value so they always update atomically. A previous bug stored the key in
  // a ref that was updated synchronously while blocks were updated via
  // setState (deferred): a render in that gap let the persistence effect
  // observe new-key + old-blocks and write one chat's prompts into another
  // chat's localStorage entry.
  const [chat, setChat] = useState<{ key: string | null; blocks: ChatBlock[] }>(
    { key: null, blocks: [] },
  );
  const blocks = chat.blocks;
  const [status, setStatus] = useState<Status>('idle');
  const statusRef = useRef<Status>('idle');
  statusRef.current = status;
  const pendingSendRef = useRef(false);
  /** Tracks user actions that fire-and-forget over WS but expect a confirming
   *  event (planModeChanged, _tool_response, etc.). Without this, the error
   *  branch below treats every error received outside `streaming` as "idle
   *  stderr" and console.warn-swallows it — so a failed plan-mode toggle or
   *  answer-card click would silently do nothing. */
  const pendingActionRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const windowTokensRef = useRef(defaultWindowForCli(cli, model));
  /** Server-confirmed plan-mode flag. Updated on `ready` and `planModeChanged`.
   *  `null` means the server hasn't told us yet. */
  const [planMode, setPlanModeState] = useState<boolean | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const teardownRef = useRef(false);
  const connectionIdRef = useRef(0);
  const turnIdRef = useRef('');
  const forceReconnectRef = useRef<() => void>(() => {});
  // Mirror the initial message into a ref so the WS onmessage handler can
  // read the latest value without re-subscribing every render.
  const initialMessageRef = useRef<string | null>(initialMessage ?? null);
  const initialSendInFlightRef = useRef(false);
  /** The pending first message already handed to the socket. A `ready` frame
   *  can send it before the effect below ever observes `ready`, and the effect
   *  re-runs on every status/model change, so both paths check this to keep
   *  one threshold-entered prompt to exactly one send. */
  const initialSentForRef = useRef<string | null>(null);
  /** The value the in-flight flags belong to. A NEW prompt clears them; a
   *  re-render of the same prompt must not. */
  const initialSeenRef = useRef<string | null>(initialMessage ?? null);
  /** Delivery ledger for the threshold prompt: which exact (conversation,
   *  text) pair has already been handed to the socket, and whether the server
   *  ever confirmed it with a turnStart. `initialSendInFlightRef` alone is not
   *  enough: turnStart and socket closes clear it by design, which reopens the
   *  window for the other send path mid-turn. This entry is NOT cleared by any
   *  server event — only by a genuinely new prompt, a conversation switch, or
   *  a socket that dies before the server confirmed the turn (so a reconnect
   *  can still retry a prompt that never landed). */
  const initialDeliveredRef = useRef<{
    key: string;
    ws: WebSocket | null;
    confirmed: boolean;
  } | null>(null);
  /** True once THIS connection has seen the server's `ready`. The pending
   *  threshold prompt must not go out before that: `ready` is what reports
   *  the session's real model/effort, and sending first would recycle the
   *  live session back to this browser's stale stored default. */
  const readySeenRef = useRef(false);
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  onInitialMessageSentRef.current = onInitialMessageSent;
  const onSessionSelectionRef = useRef(onSessionSelection);
  onSessionSelectionRef.current = onSessionSelection;
  /** Latest event seq received from server. Sent on reconnect for replay. */
  const lastSeqRef = useRef(-1);
  /** Wall-clock ms of the most recent WS message. Drives the streaming
   *  watchdog: when a silent-TCP socket leaves us stuck with thinking dots
   *  while the server has already emitted turnEnd, we notice the silence
   *  and force a reconnect so the bind-time `ready` (or replayed turnEnd)
   *  clears the dots. */
  const lastMessageAtRef = useRef(Date.now());
  /** State mirror of lastSeqRef, used purely to trigger the persistence
   *  effect so localStorage's seq stays in sync with blocks. Without this,
   *  events that bump seq without changing blocks (turnEnd, ready, dedup'd
   *  user_echo, result with usage, errors) leave persisted seq behind, and
   *  on the next reload the server replays already-rendered events → every
   *  line shows up twice. */
  const [lastSeq, setLastSeq] = useState(-1);

  useEffect(() => {
    if (initialMessage) {
      if (initialSeenRef.current !== initialMessage) {
        initialSeenRef.current = initialMessage;
        initialSentForRef.current = null;
        initialSendInFlightRef.current = false;
        initialDeliveredRef.current = null;
      }
      initialMessageRef.current = initialMessage;
      if (initialSentForRef.current === initialMessage) return;
      const ws = wsRef.current;
      if (
        repo &&
        ws &&
        ws.readyState === WebSocket.OPEN &&
        !initialSendInFlightRef.current &&
        readySeenRef.current &&
        (status === 'ready' || status === 'idle')
      ) {
        const expectedKey = conversationKey(cli, repo.path, chatId);
        const deliveryKey = `${expectedKey}\u0000${initialMessage}`;
        const delivered = initialDeliveredRef.current;
        if (
          delivered &&
          delivered.key === deliveryKey &&
          (delivered.confirmed || delivered.ws === ws)
        ) {
          // This prompt already went out on this conversation. A confirmation
          // or a still-open socket means the server has it; sending again
          // would double the turn.
          return;
        }
        initialSendInFlightRef.current = true;
        initialSentForRef.current = initialMessage;
        initialDeliveredRef.current = { key: deliveryKey, ws, confirmed: false };
        setChat((prev) => {
          if (prev.key !== expectedKey) return prev;
          const lastUser = [...prev.blocks].reverse().find((b) => b.kind === 'user');
          if (lastUser && lastUser.kind === 'user' && lastUser.text === initialMessage) return prev;
          return {
            key: prev.key,
            blocks: [
              ...prev.blocks,
              { kind: 'user', id: id(), text: initialMessage, ts: Date.now() },
            ],
          };
        });
        pendingSendRef.current = true;
        ws.send(JSON.stringify({ type: 'send', chatId, text: initialMessage, ...modelField() }));
      }
    } else if (!initialSendInFlightRef.current) {
      initialMessageRef.current = null;
      initialSentForRef.current = null;
      initialSeenRef.current = null;
      initialDeliveredRef.current = null;
    }
  }, [chatId, cli, initialMessage, modelField, repo, status]);

  // Save to localStorage whenever blocks OR lastSeq change. lastSeq must be
  // a dep so seq advances are persisted even when the event didn't mutate
  // blocks — see comment on `lastSeq` above for the duplicate-render bug
  // this prevents.
  // CRITICAL: only write when chat.key matches the current (cli, repo,
  // chatId). This guards two cases at once:
  // 1. First render after repos resolve — chat.key is null so we don't
  //    overwrite saved history with an empty initial state.
  // 2. Mid-switch render where new (cli, repo) has landed but chat.blocks
  //    still reference the previous conversation. chat.key still says
  //    "previous" so we skip until setChat({ key: new, blocks: stored })
  //    lands atomically in the connect effect.
  useEffect(() => {
    if (!repo) return;
    const key = conversationKey(cli, repo.path, chatId);
    if (chat.key !== key) return;
    writeStoredBlocks(cli, repo.path, chat.blocks, chatId);
    writeStoredSeq(cli, repo.path, lastSeqRef.current, chatId);
  }, [chat, lastSeq, repo?.path, cli, chatId]);

  useEffect(() => {
    if (!enabled || !repo) return;

    teardownRef.current = false;
    readySeenRef.current = false;
    const connectionId = ++connectionIdRef.current;
    const isCurrentConnection = () => connectionIdRef.current === connectionId && !teardownRef.current;
    // Conversation identity for this effect's lifetime. setChat updates that
    // mutate blocks must guard on prev.key === expectedKey, so a stream event
    // from a prior conversation can never append into the wrong chat.
    const expectedKey = conversationKey(cli, repo.path, chatId);
    // Restore prior blocks from localStorage so a page reload doesn't wipe
    // the chat. Atomically pair them with the owning key so the persistence
    // effect's guard can never observe new-key + old-blocks.
    const stored = readStoredBlocks(cli, repo.path, chatId);
    setChat({ key: expectedKey, blocks: stored });
    turnIdRef.current = '';
    reconnectAttemptRef.current = 0;
    windowTokensRef.current = defaultWindowForCli(cli, selectionRef.current.model);
    // Sequence we've already seen (persisted) — replay only what's newer.
    const restoredSeq = readStoredSeq(cli, repo.path, chatId);
    lastSeqRef.current = restoredSeq;
    setLastSeq(restoredSeq);

    // Bind the expected session key to THIS effect's (cli, repo, chatId) so
    // late socket events from an old conversation can never append into the
    // current chat.
    const expectedSessionKey = sessionKey(cli, repo.path, chatId);

    const detachSocket = (socket: WebSocket | null) => {
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try { socket.close(); } catch {}
    };

    const connect = () => {
      if (!isCurrentConnection()) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
      wsRef.current = ws;
      setStatus('connecting');
      setError(null);

      ws.onopen = () => {
        if (!isCurrentConnection()) return;
        reconnectAttemptRef.current = 0;
        // Fresh socket counts as fresh activity — without this, the watchdog
        // could fire instantly after a slow reconnect during a streaming turn.
        lastMessageAtRef.current = Date.now();
        ws.send(JSON.stringify({
          type: 'hello',
          cli,
          repo: repo.path,
          chatId,
          sinceSeq: lastSeqRef.current,
        }));
      };
      ws.onmessage = (e) => {
        if (!isCurrentConnection()) return;
        // If the user switched (cli/repo/chatId) and this is the previous
        // socket finishing its message queue, drop everything — the new
        // effect's WS owns the chat now.
        if (ws !== wsRef.current) return;
        // Any message proves the socket is alive — refresh the watchdog
        // before we filter / parse so even dropped messages count.
        lastMessageAtRef.current = Date.now();
        let msg: any;
        try { msg = JSON.parse(String(e.data)); }
        catch { return; }
        // Cross-(cli, repo) bleed guard. Chat-affecting messages MUST carry
        // a sessionKey matching this hook's expected (cli, repo). Anything
        // missing or mismatched is dropped — closes the hole where
        // turnStart/turnEnd could slip through unguarded.
        const CHAT_AFFECTING = new Set([
          'stream', 'turnStart', 'turnEnd', 'freshStarted',
          'sessionRebound', 'ready', 'sessionClosed',
        ]);
        if (CHAT_AFFECTING.has(msg.type)) {
          if (typeof msg.sessionKey !== 'string' || msg.sessionKey !== expectedSessionKey) {
            // eslint-disable-next-line no-console
            console.warn(
              `[useChat] dropping ${msg.type}: expected sessionKey ${expectedSessionKey}, got ${msg.sessionKey ?? 'undefined'}`,
            );
            return;
          }
        } else if (
          // For non-chat-affecting messages (e.g. `error`), only drop on a
          // present-but-mismatched sessionKey so pre-bind errors still reach
          // the client.
          typeof msg.sessionKey === 'string'
          && msg.sessionKey !== expectedSessionKey
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `[useChat] dropping cross-session ${msg.type}: expected ${expectedSessionKey}, got ${msg.sessionKey}`,
          );
          return;
        }
        // Track every server event's sequence so reconnect can resume.
        if (typeof msg.seq === 'number' && msg.seq > lastSeqRef.current) {
          lastSeqRef.current = msg.seq;
          setLastSeq(msg.seq);
        }
        if (typeof msg.latestSeq === 'number' && msg.latestSeq > lastSeqRef.current) {
          lastSeqRef.current = msg.latestSeq;
          setLastSeq(msg.latestSeq);
        }
        if (msg.type === 'ready') {
          // If the server says we attached to a busy session (Sam is mid-turn
          // because the user reconnected from a phone unlock or tab switch),
          // jump straight to 'streaming' so the UI shows tending instead of
          // looking idle while events stream in via replay.
          setStatus(msg.busy ? 'streaming' : 'ready');
          if (typeof msg.planMode === 'boolean') setPlanModeState(msg.planMode);
          if (typeof msg.model === 'string') {
            const sessionEffort = typeof msg.effort === 'string' ? msg.effort : undefined;
            const adopted = onSessionSelectionRef.current?.(msg.model, sessionEffort);
            // Adopted means this browser had no pick of its own, so the
            // pending first message below must use the session's (normalized)
            // model. The ref update is synchronous on purpose: it has to land
            // before that send reads modelField().
            if (adopted) {
              selectionRef.current = { model: adopted.model, effort: adopted.effort };
            }
          }
          readySeenRef.current = true;
          // Send a pending first message (typed straight into the threshold)
          // the moment the server says ready. Keep it pending until turnStart
          // confirms the server accepted it, so startup reconnects do not lose
          // threshold-entered prompts.
          const pending = initialMessageRef.current;
          if (pending && !initialSendInFlightRef.current && !initialSentForRef.current && ws.readyState === WebSocket.OPEN) {
            const deliveryKey = `${expectedKey}\u0000${pending}`;
            const delivered = initialDeliveredRef.current;
            if (
              delivered &&
              delivered.key === deliveryKey &&
              (delivered.confirmed || delivered.ws === ws)
            ) {
              // Already sent for this conversation. Sending again here is the
              // duplicate-turn bug: turnStart clears the in-flight flag, so a
              // late ready must not be allowed to replay the same prompt.
              return;
            }
            if (msg.busy) {
              // A turn is already running (usually ours: the socket died
              // after delivery but before turnStart). Pushing the text again
              // would queue or steer a second copy, so treat it as landed.
              if (delivered && delivered.key === deliveryKey) delivered.confirmed = true;
              return;
            }
            initialSendInFlightRef.current = true;
            initialSentForRef.current = pending;
            initialDeliveredRef.current = { key: deliveryKey, ws, confirmed: false };
            setChat((prev) => {
              if (prev.key !== expectedKey) return prev;
              const lastUser = [...prev.blocks].reverse().find((b) => b.kind === 'user');
              if (lastUser && lastUser.kind === 'user' && lastUser.text === pending) return prev;
              return {
                key: prev.key,
                blocks: [
                  ...prev.blocks,
                  { kind: 'user', id: id(), text: pending, ts: Date.now() },
                ],
              };
            });
            pendingSendRef.current = true;
            ws.send(JSON.stringify({ type: 'send', chatId, text: pending, ...modelField() }));
          }
        }
        else if (msg.type === 'planModeChanged') {
          pendingActionRef.current = false;
          if (typeof msg.planMode === 'boolean') setPlanModeState(msg.planMode);
        }
        else if (msg.type === 'sessionRebound') {
          // Server spawned a fresh process for the same (cli, cwd) — its
          // session key is unchanged but the underlying process and seq
          // numbering reset.
          lastSeqRef.current = 0;
          setLastSeq(0);
          setError(null);
        }
        else if (msg.type === 'turnStart') {
          // The server has the threshold prompt. Keep the delivery ledger's
          // entry in place (only confirmed now) so a later ready or effect run
          // can never replay it; the in-flight flags below are just UI state.
          // Only a turnStart that answers a send this socket is waiting on
          // counts as confirmation.
          if (initialSendInFlightRef.current && initialDeliveredRef.current) {
            initialDeliveredRef.current.confirmed = true;
          }
          if (initialSendInFlightRef.current) {
            initialSendInFlightRef.current = false;
            initialMessageRef.current = null;
            initialSentForRef.current = null;
            onInitialMessageSentRef.current?.();
          }
          pendingSendRef.current = false;
          pendingActionRef.current = false;
          setError(null);
          setStatus('streaming');
        }
        else if (msg.type === 'turnEnd') {
          pendingSendRef.current = false;
          pendingActionRef.current = false;
          setStatus('ready');
        }
        else if (msg.type === 'freshStarted') {
          pendingActionRef.current = false;
          setChat((prev) =>
            prev.key !== expectedKey ? prev : { key: prev.key, blocks: [] },
          );
          setUsage(null);
          setError(null);
          setStatus('ready');
          turnIdRef.current = '';
          lastSeqRef.current = 0;
          setLastSeq(0);
          if (repo) {
            writeStoredBlocks(cli, repo.path, [], chatId);
            writeStoredSeq(cli, repo.path, 0, chatId);
          }
        }
        else if (msg.type === 'sessionClosed') {
          pendingSendRef.current = false;
          pendingActionRef.current = false;
          setError('The CLI stopped mid-turn. Reconnecting now.');
          setStatus('closed');
          window.setTimeout(() => forceReconnectRef.current(), 250);
        }
        else if (msg.type === 'stream') {
          setChat((prev) =>
            prev.key !== expectedKey
              ? prev
              : {
              key: prev.key,
              blocks: reduce(prev.blocks, msg.event, turnIdRef, msg.ts),
            },
          );
          // Codex and Banana are spawn-per-turn runners whose Node-side
          // runner normalizes usage onto a synthetic `result` event. Claude
          // (and the Assistant) emit per-call usage on `assistant.message`.
          const spawnPerTurn = cli === 'codex' || cli === 'banana';
          if (
            !spawnPerTurn &&
            msg.event?.type === 'system' &&
            msg.event?.subtype === 'init' &&
            typeof msg.event?.model === 'string'
          ) {
            windowTokensRef.current = windowForClaudeModel(msg.event.model);
          }

          // Track usage from the latest model call rather than summed turn
          // totals. Claude's `result.usage` can include multiple calls after
          // tool use, which makes the meter explode; `assistant.message.usage`
          // is the per-call shape. The Codex/Banana runners emit normalized
          // usage on their synthetic result event.
          const usagePayload =
            !spawnPerTurn &&
            msg.event?.type === 'assistant' &&
            msg.event?.message?.usage
              ? (msg.event.message.usage as Record<string, number | undefined>)
              : spawnPerTurn &&
                  msg.event?.type === 'result' &&
                  msg.event?.usage
                ? (msg.event.usage as Record<string, number | undefined>)
                : null;

          if (usagePayload) {
            const u = usagePayload;
            const input = u.input_tokens ?? 0;
            const cacheRead = u.cache_read_input_tokens ?? 0;
            const cacheCreate = u.cache_creation_input_tokens ?? 0;
            const output = u.output_tokens ?? 0;
            const total = input + cacheRead + cacheCreate;
            if (
              !spawnPerTurn &&
              total > windowTokensRef.current &&
              windowTokensRef.current < LARGE_WINDOW_TOKENS
            ) {
              windowTokensRef.current = LARGE_WINDOW_TOKENS;
            }
            const windowTokens = windowTokensRef.current;
            setUsage({
              inputTokens: input,
              cacheReadTokens: cacheRead,
              cacheCreateTokens: cacheCreate,
              outputTokens: output,
              fraction: Math.min(total / windowTokens, 1),
              windowTokens,
            });
          }
        }
        else if (msg.type === 'error') {
          const inFlight =
            statusRef.current === 'streaming' ||
            statusRef.current === 'connecting' ||
            pendingSendRef.current ||
            pendingActionRef.current;
          if (inFlight) {
            pendingSendRef.current = false;
            pendingActionRef.current = false;
            setError(msg.message);
          } else {
            console.warn('[chat] suppressed idle error:', msg.message);
          }
        }
      };
      ws.onclose = () => {
        if (!isCurrentConnection()) return;
        if (initialSendInFlightRef.current) initialSendInFlightRef.current = false;
        // A prompt that went out on this socket but never got a turnStart may
        // have died with it — release the ledger AND the per-message claim so
        // the reconnect retries it. A confirmed prompt stays claimed; it must
        // never be sent twice.
        const delivered = initialDeliveredRef.current;
        if (delivered && delivered.ws === ws && !delivered.confirmed) {
          initialDeliveredRef.current = null;
          initialSentForRef.current = null;
        }
        pendingSendRef.current = false;
        setStatus('closed');
        const attempt = Math.min(reconnectAttemptRef.current, 3);
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        if (!isCurrentConnection()) return;
        setError('the line went quiet, reconnecting…');
      };
    };

    const reconcile = () => {
      if (!isCurrentConnection()) return;
      const live = wsRef.current;
      if (live && live.readyState === WebSocket.OPEN) {
        try {
          live.send(JSON.stringify({
            type: 'hello',
            cli,
            repo: repo.path,
            chatId,
            sinceSeq: lastSeqRef.current,
          }));
          return;
        } catch {
          // fall through to a forced reconnect
        }
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      detachSocket(wsRef.current);
      wsRef.current = null;
      connect();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', reconcile);
    window.addEventListener('online', reconcile);
    window.addEventListener('pageshow', reconcile);

    // Streaming-silence watchdog. If we're showing dots but the WS hasn't
    // delivered a single byte for STREAM_SILENCE_MS, the underlying
    // connection is almost certainly stale (server already emitted turnEnd,
    // it just never arrived). Forcing a brand-new WS makes bindSession reply
    // with a fresh `ready { busy: false }` (or replay the missed turnEnd),
    // which clears the dots. We deliberately bypass reconcile() here: it
    // takes an open-socket fast path that resends `hello`, but a stale-OPEN
    // socket buffers send() into a dead TCP path and the hello never lands.
    const STREAM_SILENCE_MS = 45_000;
    const WATCHDOG_TICK_MS = 5_000;
    const watchdog = window.setInterval(() => {
      if (!isCurrentConnection()) return;
      if (statusRef.current !== 'streaming') return;
      if (Date.now() - lastMessageAtRef.current < STREAM_SILENCE_MS) return;
      // eslint-disable-next-line no-console
      console.warn(`[useChat] stream watchdog: silent ${STREAM_SILENCE_MS}ms, forcing reconnect`);
      lastMessageAtRef.current = Date.now();
      forceReconnectRef.current();
    }, WATCHDOG_TICK_MS);

    forceReconnectRef.current = () => {
      if (!isCurrentConnection()) return;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      detachSocket(wsRef.current);
      wsRef.current = null;
      setError(null);
      connect();
    };

    connect();

    return () => {
      teardownRef.current = true;
      forceReconnectRef.current = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', reconcile);
      window.removeEventListener('online', reconcile);
      window.removeEventListener('pageshow', reconcile);
      window.clearInterval(watchdog);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        detachSocket(wsRef.current);
        wsRef.current = null;
      }
    };
  }, [enabled, repo?.path, cli, chatId, modelField]);

  const send = (
    text: string,
    images?: Array<{ mediaType: string; base64: string }>,
  ) => {
    if (!repo) return;
    const ws = wsRef.current;
    const expectedKey = conversationKey(cli, repo.path, chatId);
    setChat((prev) => {
      if (prev.key !== expectedKey) return prev;
      return {
        key: prev.key,
        blocks: [
          ...prev.blocks,
          { kind: 'user', id: id(), text, ts: Date.now(), images },
        ],
      };
    });
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    pendingSendRef.current = true;
    setError(null);
    ws.send(JSON.stringify({ type: 'send', chatId, text, images, ...modelField() }));
  };

  const freshStart = () => {
    if (!repo) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    ws.send(JSON.stringify({ type: 'freshStart', cli, repo: repo.path, chatId }));
  };

  const stop = () => {
    if (!repo) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'stop', cli, repo: repo.path, chatId }));
  };

  /** Stop the current turn and immediately fire a new prompt. The model sees
   *  it as a fresh turn that resumes the saved session_id, so the
   *  conversation continues but Sam stops doing whatever he was doing. */
  const steer = (
    text: string,
    images?: Array<{ mediaType: string; base64: string }>,
  ) => {
    if (!repo) return;
    const ws = wsRef.current;
    const expectedKey = conversationKey(cli, repo.path, chatId);
    setChat((prev) => {
      if (prev.key !== expectedKey) return prev;
      return {
        key: prev.key,
        blocks: [
          ...prev.blocks,
          { kind: 'user', id: id(), text, ts: Date.now(), images },
        ],
      };
    });
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    pendingSendRef.current = true;
    setError(null);
    ws.send(JSON.stringify({ type: 'steer', cli, repo: repo.path, chatId, text, images, ...modelField() }));
  };

  const reconnect = () => forceReconnectRef.current();

  /** Reply to an interactive tool (AskUserQuestion / ExitPlanMode) with a
   *  tool_result so the model can finish its turn instead of looping. */
  const respondToTool = (toolUseId: string, content: string) => {
    if (!repo) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    pendingActionRef.current = true;
    setError(null);
    ws.send(JSON.stringify({
      type: 'toolResponse',
      cli, repo: repo.path, chatId, toolUseId, content,
    }));
  };

  /** Toggle plan mode for this (cli, repo, chatId). Server persists the flag,
   *  recycles the warm process if it changed, and echoes back planModeChanged. */
  const setPlanMode = (enabled: boolean) => {
    if (!repo) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line. Please wait a moment.');
      return;
    }
    pendingActionRef.current = true;
    setError(null);
    ws.send(JSON.stringify({
      type: 'setPlanMode',
      cli, repo: repo.path, chatId, enabled,
    }));
  };

  const displayedUsage = usage && cli === 'codex'
    ? (() => {
        const windowTokens = contextWindowForCodexModel(model);
        const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens;
        return {
          ...usage,
          fraction: Math.min(total / windowTokens, 1),
          windowTokens,
        };
      })()
    : usage;

  return {
    blocks, status, error, send, steer, freshStart, stop, reconnect, usage: displayedUsage,
    planMode, setPlanMode, respondToTool,
  };
}
