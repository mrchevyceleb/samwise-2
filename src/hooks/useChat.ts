import { useEffect, useRef, useState } from 'react';
import type { ChatBlock, CompanionId, Repo } from '../data/types';

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

let nextId = 1;
const id = () => `b${nextId++}`;

// Pure reducer — all per-turn state lives on the blocks themselves
// (turnId + cbIndex). This keeps it safe under React Strict Mode, which
// invokes reducers twice for purity-checking.
function reduce(blocks: ChatBlock[], ev: any, turnIdRef: { current: string }): ChatBlock[] {
  if (!ev || typeof ev !== 'object') return blocks;

  if (ev.type === 'stream_event' && ev.event) {
    return reduce(blocks, ev.event, turnIdRef);
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
        kind: 'text', id: id(), text: '', ts: Date.now(),
        turnId, cbIndex: idx, open: true,
      };
      return [...blocks, block];
    }
    if (cb?.type === 'tool_use') {
      const block: ChatBlock = {
        kind: 'tool', id: id(),
        toolUseId: cb.id, tool: cb.name, args: '',
        running: true, ts: Date.now(),
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
}) {
  const { repo, cli, chatId = 'main', enabled, initialMessage, onInitialMessageSent } = opts;
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
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  onInitialMessageSentRef.current = onInitialMessageSent;
  /** Latest event seq received from server. Sent on reconnect for replay. */
  const lastSeqRef = useRef(-1);
  /** State mirror of lastSeqRef, used purely to trigger the persistence
   *  effect so localStorage's seq stays in sync with blocks. Without this,
   *  events that bump seq without changing blocks (turnEnd, ready, dedup'd
   *  user_echo, result with usage, errors) leave persisted seq behind, and
   *  on the next reload the server replays already-rendered events → every
   *  line shows up twice. */
  const [lastSeq, setLastSeq] = useState(-1);

  useEffect(() => {
    if (initialMessage) {
      initialMessageRef.current = initialMessage;
      initialSendInFlightRef.current = false;
      const ws = wsRef.current;
      if (
        repo &&
        ws &&
        ws.readyState === WebSocket.OPEN &&
        (status === 'ready' || status === 'idle')
      ) {
        const expectedKey = conversationKey(cli, repo.path, chatId);
        initialSendInFlightRef.current = true;
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
        ws.send(JSON.stringify({ type: 'send', chatId, text: initialMessage }));
      }
    } else if (!initialSendInFlightRef.current) {
      initialMessageRef.current = null;
    }
  }, [chatId, cli, initialMessage, repo, status]);

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
          // Send a pending first message (typed straight into the threshold)
          // the moment the server says ready. Keep it pending until turnStart
          // confirms the server accepted it, so startup reconnects do not lose
          // threshold-entered prompts.
          const pending = initialMessageRef.current;
          if (pending && !initialSendInFlightRef.current && ws.readyState === WebSocket.OPEN) {
            initialSendInFlightRef.current = true;
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
            ws.send(JSON.stringify({ type: 'send', chatId, text: pending }));
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
          if (initialSendInFlightRef.current) {
            initialSendInFlightRef.current = false;
            initialMessageRef.current = null;
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
              : { key: prev.key, blocks: reduce(prev.blocks, msg.event, turnIdRef) },
          );
          // Track usage from claude's `result` events to power the context meter.
          if (msg.event?.type === 'result' && msg.event?.usage) {
            const u = msg.event.usage as Record<string, number | undefined>;
            const input = u.input_tokens ?? 0;
            const cacheRead = u.cache_read_input_tokens ?? 0;
            const cacheCreate = u.cache_creation_input_tokens ?? 0;
            const output = u.output_tokens ?? 0;
            const total = input + cacheRead + cacheCreate;
            setUsage({
              inputTokens: input,
              cacheReadTokens: cacheRead,
              cacheCreateTokens: cacheCreate,
              outputTokens: output,
              fraction: Math.min(total / DEFAULT_WINDOW_TOKENS, 1),
              windowTokens: DEFAULT_WINDOW_TOKENS,
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
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        detachSocket(wsRef.current);
        wsRef.current = null;
      }
    };
  }, [enabled, repo?.path, cli, chatId]);

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
    ws.send(JSON.stringify({ type: 'send', chatId, text, images }));
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
    ws.send(JSON.stringify({ type: 'steer', cli, repo: repo.path, chatId, text, images }));
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

  return {
    blocks, status, error, send, steer, freshStart, stop, reconnect, usage,
    planMode, setPlanMode, respondToTool,
  };
}
