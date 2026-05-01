import { SamPortrait } from '../primitives/atoms';
import type { ChronicleEvent, ChronicleEventKind } from '../../data/mock';
import type { CompanionId, LiveSession } from '../../data/types';

const COMPANION_LABEL: Record<CompanionId, string> = {
  claude: 'claude',
  codex: 'codex',
  assistant: 'assistant',
};

const dotColor: Record<ChronicleEventKind, string> = {
  ember: 'var(--ember)',
  gold: 'var(--gold)',
  moss: 'var(--moss)',
  ink: 'var(--ink-faint)',
};

export function ChronicleRibbon({
  events,
  activeId,
  collapsed = false,
  onSelect,
  onNew,
  theme = 'light',
  onToggleTheme,
  liveSessions = [],
  onSelectLive,
}: {
  events: ChronicleEvent[];
  activeId?: string | null;
  collapsed?: boolean;
  onSelect?: (id: string) => void;
  onNew?: () => void;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
  liveSessions?: LiveSession[];
  onSelectLive?: (s: LiveSession) => void;
}) {
  const wide = !collapsed;
  const ribbonWidth = wide ? 260 : 104;
  const railLeft = wide ? 22 : 24;
  const contentPadLeft = wide ? 36 : 42;
  return (
    <aside
      className="sw-chronicle-ribbon"
      style={{
        position: 'sticky',
        top: 0,
        alignSelf: 'flex-start',
        width: ribbonWidth,
        height: '100dvh',
        borderRight: '1px solid var(--rule-soft)',
        backdropFilter: 'blur(6px)',
        padding: '22px 0 18px',
        transition: 'width 0.2s',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div
        onClick={onNew}
        title="back to the threshold"
        style={{
          padding: wide ? '0 18px 14px' : '0 20px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
        }}
      >
        <SamPortrait size={wide ? 30 : 34} />
        {wide && (
          <span className="sw-smallcaps" style={{ fontSize: 12, color: 'var(--ink)' }}>
            The chronicle
          </span>
        )}
        {wide && (
          <span className="sw-folio" style={{ marginLeft: 'auto', fontSize: 14, color: 'var(--ink-soft)' }}>
            v
          </span>
        )}
      </div>
      <hr className="sw-rule-solid" style={{ margin: wide ? '0 16px 12px' : '0 14px 12px' }} />

      {liveSessions.length > 0 && (
        <div style={{ padding: wide ? '0 14px 10px' : '0 10px 10px' }}>
          {wide && (
            <div
              className="sw-smallcaps"
              style={{ fontSize: 11.5, color: 'var(--ember)', marginBottom: 6, letterSpacing: '0.18em' }}
            >
              · now ·
            </div>
          )}
          {liveSessions.map((s) => (
            <div
              key={`${s.cli}|${s.cwd}`}
              onClick={() => onSelectLive?.(s)}
              title={`${COMPANION_LABEL[s.cli]} · ${s.cwd}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: wide ? 10 : 8,
                padding: wide ? '6px 8px' : '7px 6px',
                marginBottom: 4,
                borderRadius: 2,
                cursor: 'pointer',
                background: s.busy ? 'rgba(184,89,58,0.10)' : 'transparent',
              }}
            >
              <span
                style={{
                  width: wide ? 10 : 11,
                  height: wide ? 10 : 11,
                  borderRadius: '50%',
                  background: 'var(--ember)',
                  flexShrink: 0,
                  animation: s.busy ? 'sw-pulse 1.4s infinite' : 'none',
                  opacity: s.busy ? 1 : 0.5,
                }}
              />
              {wide && (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: 'var(--serif-display)',
                      fontStyle: 'italic',
                      fontSize: 16,
                      color: 'var(--ink)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      lineHeight: 1.2,
                    }}
                  >
                    {s.repoName}
                  </div>
                  <div
                    className="sw-mono"
                    style={{
                      fontSize: 12,
                      color: 'var(--ink-soft)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {COMPANION_LABEL[s.cli]}{s.busy ? ' · tending' : ' · idle'}
                  </div>
                </div>
              )}
              {!wide && (
                <span
                  className="sw-smallcaps"
                  style={{
                    fontSize: 12,
                    color: s.busy ? 'var(--ember)' : 'var(--ink-soft)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {COMPANION_LABEL[s.cli]}
                </span>
              )}
            </div>
          ))}
          <hr className="sw-rule-solid" style={{ margin: '8px 0 4px', opacity: 0.5 }} />
        </div>
      )}

      <div
        className="sw-scroll"
        style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
      >
        <div style={{ position: 'relative', paddingLeft: contentPadLeft }}>
          <div
            style={{
              position: 'absolute',
              left: railLeft,
              top: 6,
              bottom: 6,
              width: 2,
              background: 'var(--rule)',
              opacity: 0.85,
            }}
          />
          {events.map((e) => {
            const c = dotColor[e.kind];
            const active = e.id === activeId;
            const padTop = wide ? 8 : 9;
            const padBottom = wide ? 10 : 9;
            const padRight = wide ? 14 : 10;
            const padLeft = active ? 7 : 0;
            return (
              <div
                key={e.id}
                onClick={() => onSelect?.(e.id)}
                style={{
                  position: 'relative',
                  paddingTop: padTop,
                  paddingRight: padRight,
                  paddingBottom: padBottom,
                  paddingLeft: padLeft,
                  background: active ? 'rgba(184,89,58,0.06)' : 'transparent',
                  borderLeft: active
                    ? '2px solid var(--ember)'
                    : '2px solid transparent',
                  marginLeft: active ? -2 : 0,
                  cursor: 'pointer',
                  minHeight: wide ? 64 : 36,
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: wide ? -20 : -25,
                    top: wide ? 13 : 12,
                    width: wide ? 11 : 12,
                    height: wide ? 11 : 12,
                    borderRadius: '50%',
                    background: 'var(--vellum)',
                    border: `1.75px solid ${c}`,
                    animation: e.busy ? 'sw-pulse 1.4s infinite' : 'none',
                  }}
                />
                {wide ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span className="sw-folio" style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                        {e.t}
                      </span>
                      {e.awaits && (
                        <span
                          className="sw-smallcaps"
                          style={{ fontSize: 11, color: 'var(--gold)' }}
                        >
                          asks
                        </span>
                      )}
                      {e.busy && (
                        <span
                          className="sw-smallcaps"
                          style={{ fontSize: 11, color: 'var(--ember)' }}
                        >
                          now
                        </span>
                      )}
                      {e.running && !e.busy && (
                        <span
                          className="sw-smallcaps"
                          style={{ fontSize: 11, color: 'var(--gold)' }}
                        >
                          warm
                        </span>
                      )}
                      {e.asleep && (
                        <span
                          className="sw-smallcaps"
                          style={{ fontSize: 11, color: 'var(--ink-soft)' }}
                        >
                          asleep
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--serif-body)',
                        fontSize: 16,
                        color: active ? 'var(--ink)' : 'var(--ink-2)',
                        fontWeight: active ? 500 : 400,
                        lineHeight: 1.25,
                        marginTop: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {e.title}
                    </div>
                    <div
                      className="sw-mono"
                      style={{
                        fontSize: 12,
                        color: 'var(--ink-soft)',
                        marginTop: 1,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {e.repo}
                    </div>
                  </>
                ) : (
                  <span
                    className="sw-folio"
                    style={{
                      fontSize: 15,
                      display: 'block',
                      textAlign: 'left',
                      color: active ? 'var(--ember)' : 'var(--ink-2)',
                      lineHeight: 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.t}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          padding: wide ? '10px 14px 0' : '10px 10px 0',
          borderTop: '1px solid var(--rule-soft)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <button
          className="sw-btn"
          onClick={onNew}
          style={{
            width: '100%',
            fontSize: wide ? 14 : 16,
            padding: wide ? '8px 10px' : '9px 0',
            fontFamily: 'var(--serif-display)',
            fontStyle: 'italic',
          }}
        >
          {wide ? '+ a new errand' : '+'}
        </button>
        {onToggleTheme && (
          <button
            className="sw-btn"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'switch to day' : 'switch to dusk'}
            aria-label={theme === 'dark' ? 'switch to light mode' : 'switch to dark mode'}
            style={{
              width: '100%',
              fontSize: wide ? 14 : 16,
              padding: wide ? '8px 10px' : '9px 0',
              fontFamily: 'var(--serif-display)',
              fontStyle: 'italic',
              color: 'var(--ink-soft)',
            }}
          >
            {wide ? (theme === 'dark' ? 'sun ☀' : 'dusk ☾') : theme === 'dark' ? '☀' : '☾'}
          </button>
        )}
      </div>
    </aside>
  );
}
