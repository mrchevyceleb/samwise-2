import { useEffect, useRef, useState } from 'react';

// Fetches the current git branch for a repo path. Re-runs when `path`
// changes; call `refresh()` to re-fetch (e.g., after a turn that may
// have switched branches via `git checkout`).
export function useLiveBranch(path: string | undefined): {
  branch: string | undefined;
  refresh: () => void;
} {
  const [snapshot, setSnapshot] = useState<{
    path: string;
    branch: string | undefined;
  } | null>(null);
  const [tick, setTick] = useState(0);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!path) {
      reqIdRef.current += 1;
      return;
    }
    const id = ++reqIdRef.current;
    fetch(`/api/branch?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { branch: string | null }) => {
        if (id !== reqIdRef.current) return;
        setSnapshot({ path, branch: data.branch ?? undefined });
      })
      .catch(() => {
        // Soft-fail. The returned branch is keyed by path, so stale labels stay hidden.
      });
  }, [path, tick]);

  const branch = snapshot && snapshot.path === path ? snapshot.branch : undefined;
  return { branch, refresh: () => setTick((t) => t + 1) };
}
