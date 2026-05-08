import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveSession } from '../data/types';

// Polls /api/live every few seconds so the chronicle ribbon can show which
// (cli, repo) sessions are running right now and which one is currently
// "tending" (busy mid-turn).

const POLL_MS = 4000;

export type UseLiveResult = {
  sessions: LiveSession[];
  /** Optimistically remove a row from local state. Caller is responsible for
   *  triggering the server-side action; the next poll (or `refetch`) will
   *  reconcile. We deliberately do NOT auto-refetch here — racing the POST
   *  would let the still-running server put the row right back into state. */
  removeLocal: (cli: string, cwd: string, chatId?: string | null) => void;
  /** Force an immediate poll. Use after a server-mutating call resolves. */
  refetch: () => void;
};

export function useLive(): UseLiveResult {
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(async () => {
    try {
      const r = await fetch('/api/live');
      if (!r.ok) return;
      const data = (await r.json()) as { sessions: LiveSession[] };
      if (cancelledRef.current) return;
      setSessions(data.sessions);
    } catch {
      // Ignore — server might be bouncing.
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    let timer: number | null = null;

    const tick = async () => {
      await fetchOnce();
      if (!cancelledRef.current) timer = window.setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchOnce]);

  const removeLocal = useCallback((cli: string, cwd: string, chatId?: string | null) => {
    const normalizedChatId = chatId || 'main';
    setSessions((prev) => prev.filter((s) => !(
      s.cli === cli &&
      s.cwd === cwd &&
      (s.chatId || 'main') === normalizedChatId
    )));
  }, []);

  const refetch = useCallback(() => { void fetchOnce(); }, [fetchOnce]);

  return { sessions, removeLocal, refetch };
}
