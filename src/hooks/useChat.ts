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
        return { ...b, args: prettifyJson(b.args), open: false };
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
            ? { ...b, result: summary, running: false }
            : b,
        );
      }
    }
    return next;
  }

  // Final `assistant` event: with content_block_* coverage above we already
  // have everything. Skip.

  return blocks;
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

export function useChat(opts: {
  repo: Repo | undefined;
  cli: CompanionId;
  enabled: boolean;
  initialMessage?: string | null;
  onInitialMessageSent?: () => void;
}) {
  const { repo, cli, enabled, initialMessage, onInitialMessageSent } = opts;
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const teardownRef = useRef(false);
  const turnIdRef = useRef('');
  // Mirror the initial message into a ref so the WS onmessage handler can
  // read the latest value without re-subscribing every render.
  const initialMessageRef = useRef<string | null>(initialMessage ?? null);
  initialMessageRef.current = initialMessage ?? null;
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  onInitialMessageSentRef.current = onInitialMessageSent;

  useEffect(() => {
    if (!enabled || !repo) return;

    teardownRef.current = false;
    setBlocks([]);
    turnIdRef.current = '';
    reconnectAttemptRef.current = 0;

    const connect = () => {
      if (teardownRef.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${window.location.host}/api/ws`);
      wsRef.current = ws;
      setStatus('connecting');
      setError(null);

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        ws.send(JSON.stringify({ type: 'hello', cli, repo: repo.path }));
      };
      ws.onmessage = (e) => {
        let msg: any;
        try { msg = JSON.parse(String(e.data)); }
        catch { return; }
        if (msg.type === 'ready') {
          setStatus('ready');
          // Send a pending first message (typed straight into the threshold)
          // the moment the server says ready, not via a downstream effect.
          const pending = initialMessageRef.current;
          if (pending && ws.readyState === WebSocket.OPEN) {
            initialMessageRef.current = null;
            setBlocks((prev) => [
              ...prev,
              { kind: 'user', id: id(), text: pending, ts: Date.now() },
            ]);
            ws.send(JSON.stringify({ type: 'send', text: pending }));
            onInitialMessageSentRef.current?.();
          }
        }
        else if (msg.type === 'turnStart') setStatus('streaming');
        else if (msg.type === 'turnEnd') setStatus('ready');
        else if (msg.type === 'freshStarted') {
          setBlocks([]);
          setUsage(null);
          setError(null);
          setStatus('ready');
          turnIdRef.current = '';
        }
        else if (msg.type === 'sessionClosed') {
          setError('Sam closed the session — say something to wake him.');
          setStatus('ready');
        }
        else if (msg.type === 'stream') {
          setBlocks((prev) => reduce(prev, msg.event, turnIdRef));
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
        else if (msg.type === 'error') setError(msg.message);
      };
      ws.onclose = () => {
        if (teardownRef.current) return;
        setStatus('closed');
        const attempt = Math.min(reconnectAttemptRef.current, 3);
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        setError('the line went quiet — reconnecting…');
      };
    };

    connect();

    return () => {
      teardownRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, repo?.path, cli]);

  const send = (text: string) => {
    const ws = wsRef.current;
    setBlocks((prev) => [
      ...prev,
      { kind: 'user', id: id(), text, ts: Date.now() },
    ]);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line — please wait a moment.');
      return;
    }
    setError(null);
    ws.send(JSON.stringify({ type: 'send', text }));
  };

  const freshStart = () => {
    if (!repo) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError('Sam is not on the line — please wait a moment.');
      return;
    }
    ws.send(JSON.stringify({ type: 'freshStart', cli, repo: repo.path }));
  };

  return { blocks, status, error, send, freshStart, usage };
}
