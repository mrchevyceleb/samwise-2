import { useEffect, useState } from 'react';
import type { Repo } from '../data/types';

type State =
  | { status: 'loading'; repos: Repo[] }
  | { status: 'ready'; repos: Repo[] }
  | { status: 'error'; repos: Repo[]; message: string };

// Server sorts starred first, then by mtime. Mirror that when re-sorting
// locally after an optimistic star toggle so the row jumps to the top
// without a refetch.
function resort(repos: Repo[]): Repo[] {
  return [...repos].sort((a, b) => {
    const aStar = a.starred ? 1 : 0;
    const bStar = b.starred ? 1 : 0;
    if (aStar !== bStar) return bStar - aStar;
    return 0; // preserve incoming order otherwise (server already mtime-sorted)
  });
}

export function useRepos(): State & {
  reload: () => void;
  toggleStar: (path: string) => Promise<void>;
} {
  const [state, setState] = useState<State>({ status: 'loading', repos: [] });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/repos')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { repos: Repo[] }) => {
        if (cancelled) return;
        setState({ status: 'ready', repos: data.repos });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState({ status: 'error', repos: [], message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const toggleStar = async (path: string) => {
    // Optimistic flip: update local state immediately, post in the background,
    // revert if the server rejects.
    let previous: Repo[] = [];
    setState((s) => {
      previous = s.repos;
      const next = resort(
        s.repos.map((r) => (r.path === path ? { ...r, starred: !r.starred } : r)),
      );
      return { ...s, repos: next } as State;
    });
    try {
      const r = await fetch('/api/stars/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.warn('star toggle failed, reverting', e);
      setState((s) => ({ ...s, repos: previous } as State));
    }
  };

  return { ...state, reload: () => setTick((t) => t + 1), toggleStar };
}
