import { useEffect, useMemo, useRef, useState } from 'react';

// Model picker shown only when the Banana runner is the active companion.
// Quick-picks the four monkey tiers, or searches any OpenRouter model. The
// chosen id is `monkey/<tier>` or `openrouter/<model.id>`; it threads through
// useChat -> the WS send payload -> BananaSession.send -> sdk.session.prompt.

export const BANANA_MODEL_STORAGE_KEY = 'samwise-2:banana-model';
export const DEFAULT_BANANA_MODEL = 'monkey/silverback';

type MonkeyTier = { id: string; label: string; blurb: string };

// The four monkey tiers. Order is strongest -> lightest.
const MONKEY_TIERS: MonkeyTier[] = [
  { id: 'monkey/silverback', label: 'Silverback', blurb: 'the heaviest tier' },
  { id: 'monkey/mandrill', label: 'Mandrill', blurb: 'strong and balanced' },
  { id: 'monkey/gibbon', label: 'Gibbon', blurb: 'quick and nimble' },
  { id: 'monkey/tamarin', label: 'Tamarin', blurb: 'the lightest tier' },
];

type OpenRouterModel = { id: string; name: string };

// Module-level cache so the OpenRouter list is fetched once per page load.
let openRouterCache: OpenRouterModel[] | null = null;
let openRouterInFlight: Promise<OpenRouterModel[]> | null = null;

async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (openRouterCache) return openRouterCache;
  if (openRouterInFlight) return openRouterInFlight;
  openRouterInFlight = (async () => {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list: OpenRouterModel[] = Array.isArray(json?.data)
        ? json.data
            .filter((m: any) => m && typeof m.id === 'string')
            .map((m: any) => ({ id: m.id as string, name: (m.name as string) || (m.id as string) }))
        : [];
      // Only cache a non-empty result. A transient failure (offline, rate
      // limit) must not poison the cache for the rest of the page load.
      if (list.length > 0) openRouterCache = list;
      return list;
    } catch {
      // Leave the cache empty so the next panel-open retries the fetch.
      return [];
    } finally {
      openRouterInFlight = null;
    }
  })();
  return openRouterInFlight;
}

/** Read the persisted last-picked model, falling back to the initial default. */
export function readStoredBananaModel(): string {
  if (typeof window === 'undefined') return DEFAULT_BANANA_MODEL;
  try {
    return localStorage.getItem(BANANA_MODEL_STORAGE_KEY) || DEFAULT_BANANA_MODEL;
  } catch {
    return DEFAULT_BANANA_MODEL;
  }
}

function writeStoredBananaModel(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(BANANA_MODEL_STORAGE_KEY, id);
  } catch {
    // storage unavailable — keep going, just no persistence
  }
}

/** Human label for a model id. Monkey tiers get their nice name; OpenRouter
 *  ids show the bare model id after the `openrouter/` prefix. */
export function labelForBananaModel(id: string): string {
  const tier = MONKEY_TIERS.find((t) => t.id === id);
  if (tier) return tier.label;
  if (id.startsWith('openrouter/')) return id.slice('openrouter/'.length);
  return id;
}

type Props = {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
};

// The panel's natural max height. Used to decide drop direction so the panel
// is never clipped below the viewport (it sits in the mobile composer, pinned
// to the bottom of the screen, where a downward panel would be off-screen).
const PANEL_MAX_HEIGHT = 380;

export function BananaModelPicker({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [orModels, setOrModels] = useState<OpenRouterModel[]>(openRouterCache ?? []);
  // 'down' (default) or 'up' when there is not enough room below the trigger.
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fetch the OpenRouter list once when the panel first opens.
  useEffect(() => {
    if (!open || orModels.length > 0) return;
    let alive = true;
    void fetchOpenRouterModels().then((list) => {
      if (alive) setOrModels(list);
    });
    return () => {
      alive = false;
    };
  }, [open, orModels.length]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orModels.slice(0, 50);
    return orModels
      .filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      .slice(0, 50);
  }, [orModels, query]);

  const pick = (id: string) => {
    writeStoredBananaModel(id);
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  // Open the panel, choosing the drop direction so it is never clipped below
  // the viewport. If the room under the trigger is smaller than the panel and
  // there is more room above, drop upward instead.
  const toggleOpen = () => {
    if (disabled) return;
    setOpen((wasOpen) => {
      if (wasOpen) return false;
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) {
        const below = window.innerHeight - rect.bottom;
        const above = rect.top;
        setDropUp(below < PANEL_MAX_HEIGHT + 16 && above > below);
      }
      return true;
    });
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={toggleOpen}
        disabled={disabled}
        title="choose the model Banana runs"
        style={{
          background: 'transparent',
          color: 'var(--ink-soft)',
          border: '1px solid var(--rule)',
          borderRadius: 999,
          padding: '3px 12px',
          fontFamily: 'var(--serif-display)',
          fontStyle: 'italic',
          fontSize: 12.5,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          whiteSpace: 'nowrap',
          transition: 'transform 0.12s ease, border-color 0.12s ease',
        }}
        onMouseEnter={(e) => {
          if (!disabled) e.currentTarget.style.transform = 'scale(1.04)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        model · {labelForBananaModel(value)} {open ? '▴' : '▾'}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            ...(dropUp
              ? { bottom: 'calc(100% + 8px)' }
              : { top: 'calc(100% + 8px)' }),
            left: '50%',
            transform: 'translateX(-50%)',
            width: 288,
            maxHeight: PANEL_MAX_HEIGHT,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--vellum)',
            border: '1px solid var(--rule)',
            borderRadius: 12,
            boxShadow: '0 14px 40px rgba(0,0,0,0.22)',
            zIndex: 50,
            overflow: 'hidden',
            animation: `${dropUp ? 'sw-picker-pop-up' : 'sw-picker-pop'} 0.16s ease-out`,
          }}
        >
          <div style={{ padding: '10px 12px 6px' }}>
            <div
              style={{
                fontFamily: 'var(--serif-display)',
                fontStyle: 'italic',
                fontSize: 11.5,
                color: 'var(--ink-faint)',
                marginBottom: 6,
                textTransform: 'lowercase',
                letterSpacing: '0.04em',
              }}
            >
              the monkey tiers
            </div>
            {MONKEY_TIERS.map((tier) => {
              const active = tier.id === value;
              return (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => pick(tier.id)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 8,
                    background: active ? 'var(--gold)' : 'transparent',
                    color: active ? 'var(--vellum)' : 'var(--ink-soft)',
                    border: 'none',
                    borderRadius: 8,
                    padding: '6px 9px',
                    cursor: 'pointer',
                    fontSize: 13,
                    textAlign: 'left',
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'var(--rule-soft)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{tier.label}</span>
                  <span
                    style={{
                      fontFamily: 'var(--serif-display)',
                      fontStyle: 'italic',
                      fontSize: 11,
                      opacity: 0.8,
                    }}
                  >
                    {tier.blurb}
                  </span>
                </button>
              );
            })}
          </div>

          <div
            style={{
              borderTop: '1px solid var(--rule-soft)',
              padding: '8px 12px 4px',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--serif-display)',
                fontStyle: 'italic',
                fontSize: 11.5,
                color: 'var(--ink-faint)',
                marginBottom: 6,
                textTransform: 'lowercase',
                letterSpacing: '0.04em',
              }}
            >
              or any openrouter model
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search openrouter…"
              autoFocus
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--paper, var(--vellum))',
                color: 'var(--ink)',
                border: '1px solid var(--rule)',
                borderRadius: 8,
                padding: '5px 9px',
                fontSize: 12.5,
                fontFamily: 'var(--serif-display)',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ overflowY: 'auto', padding: '4px 8px 10px', flex: 1 }}>
            {orModels.length === 0 && (
              <div
                style={{
                  fontFamily: 'var(--serif-display)',
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: 'var(--ink-faint)',
                  padding: '8px 6px',
                }}
              >
                fetching the OpenRouter roster…
              </div>
            )}
            {orModels.length > 0 && filtered.length === 0 && (
              <div
                style={{
                  fontFamily: 'var(--serif-display)',
                  fontStyle: 'italic',
                  fontSize: 12,
                  color: 'var(--ink-faint)',
                  padding: '8px 6px',
                }}
              >
                no model matches "{query}"
              </div>
            )}
            {filtered.map((m) => {
              const id = `openrouter/${m.id}`;
              const active = id === value;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pick(id)}
                  title={m.id}
                  style={{
                    display: 'block',
                    width: '100%',
                    background: active ? 'var(--gold)' : 'transparent',
                    color: active ? 'var(--vellum)' : 'var(--ink-soft)',
                    border: 'none',
                    borderRadius: 7,
                    padding: '5px 9px',
                    cursor: 'pointer',
                    fontSize: 12.5,
                    textAlign: 'left',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'var(--rule-soft)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        @keyframes sw-picker-pop {
          from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(0.97); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
        @keyframes sw-picker-pop-up {
          from { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.97); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}
