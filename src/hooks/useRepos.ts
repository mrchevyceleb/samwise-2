import { useEffect, useRef, useState } from 'react';
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
  toggleArchive: (path: string) => Promise<void>;
  showArchived: boolean;
  setShowArchived: (v: boolean) => void;
  archiveError: string | null;
} {
  const [state, setState] = useState<State>({ status: 'loading', repos: [] });
  const [tick, setTick] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  // Bumped on every archive mutation. A discovery fetch that started before
  // a mutation can resolve after it and overwrite the reconciled state with
  // a stale snapshot, so responses captured with an older generation are
  // discarded and refetched.
  const mutationGen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const genAtStart = mutationGen.current;
    fetch(showArchived ? '/api/repos?includeArchived=1' : '/api/repos')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { repos: Repo[] }) => {
        if (cancelled) return;
        if (genAtStart !== mutationGen.current) {
          // A mutation landed while this fetch was in flight: the response
          // may predate it. Refetch instead of applying a stale snapshot.
          setTick((t) => t + 1);
          return;
        }
        setState({ status: 'ready', repos: data.repos });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState({ status: 'error', repos: [], message: e.message });
      });
    return () => {
      cancelled = true;
    };
  }, [tick, showArchived]);

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

  const toggleArchive = async (path: string) => {
    // Optimistic flip: hide (or restore) the row immediately, post in the
    // background. On failure we refetch canonical state from the server
    // instead of restoring a stale snapshot of the whole list, which would
    // clobber any star/archive flips that happened in the meantime.
    setArchiveError(null);
    mutationGen.current += 1;
    setState((s) => {
      const next = s.repos
        .map((r) => (r.path === path ? { ...r, archived: !r.archived } : r))
        .filter((r) => showArchived || !r.archived);
      return { ...s, repos: next } as State;
    });
    try {
      const r = await fetch('/api/archived/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Reconcile with the server's authoritative state: another device may
      // have changed the flag, making our optimistic flip land the wrong way.
      const data = (await r.json()) as { archived?: boolean };
      if (typeof data.archived === 'boolean') {
        let needsRefetch = false;
        setState((s) => {
          // The optimistic flip may have filtered the row out entirely. If
          // the server now says it is NOT archived, no local update can
          // reinsert it — refetch canonical state instead.
          if (!s.repos.some((repo) => repo.path === path) && !data.archived) {
            needsRefetch = true;
            return s;
          }
          const next = s.repos
            .map((repo) => (repo.path === path ? { ...repo, archived: data.archived } : repo))
            .filter((repo) => showArchived || !repo.archived);
          return { ...s, repos: next } as State;
        });
        if (needsRefetch) setTick((t) => t + 1);
      }
    } catch (e) {
      console.warn('archive toggle failed, refreshing from server', e);
      setArchiveError('the archived shelf did not update, refreshed from the server');
      setTick((t) => t + 1);
    }
  };

  return {
    ...state,
    reload: () => setTick((t) => t + 1),
    toggleStar,
    toggleArchive,
    showArchived,
    setShowArchived,
    archiveError,
  };
}
