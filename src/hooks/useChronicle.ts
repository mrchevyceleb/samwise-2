import { useEffect, useState } from 'react';
import type { ChronicleEvent } from '../data/mock';

type ServerEntry = {
  id: string;
  title: string;
  cwd: string;
  repoName: string;
  ts: number;
  running: boolean;
};

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'yest';
  const days = Math.round((now.getTime() - ms) / (24 * 60 * 60 * 1000));
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function toEvent(e: ServerEntry): ChronicleEvent {
  return {
    id: e.id,
    t: timeLabel(e.ts),
    title: e.title,
    repo: e.repoName,
    kind: e.running ? 'ember' : 'moss',
    running: e.running || undefined,
    done: !e.running || undefined,
    status: e.running ? 'tending now' : 'finished',
  };
}

type State = {
  events: ChronicleEvent[];
  loading: boolean;
  error: string | null;
};

export function useChronicle(refreshKey: number = 0): State & { reload: () => void } {
  const [state, setState] = useState<State>({ events: [], loading: true, error: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetch('/api/chronicle')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { events: ServerEntry[] }) => {
        if (cancelled) return;
        setState({
          events: data.events.map(toEvent),
          loading: false,
          error: null,
        });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState({ events: [], loading: false, error: e.message });
      });
    return () => { cancelled = true; };
  }, [tick, refreshKey]);

  return { ...state, reload: () => setTick((t) => t + 1) };
}
