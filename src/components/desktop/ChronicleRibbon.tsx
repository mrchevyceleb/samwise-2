import { SamPortrait } from '../primitives/atoms';
import type { ChronicleEvent, ChronicleEventKind } from '../../data/mock';

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
}: {
  events: ChronicleEvent[];
  activeId?: string | null;
  collapsed?: boolean;
  onSelect?: (id: string) => void;
  onNew?: () => void;
}) {
  const wide = !collapsed;
  return (
    <aside
      style={{
        position: 'sticky',
        top: 0,
        alignSelf: 'flex-start',
        width: wide ? 200 : 56,
        height: '100dvh',
        borderRight: '1px solid var(--rule-soft)',
        background: 'rgba(232, 220, 196, 0.4)',
        backdropFilter: 'blur(6px)',
        padding: '20px 0',
        transition: 'width 0.2s',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: wide ? '0 16px 8px' : '0 12px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <SamPortrait size={20} />
        {wide && (
          <span className="sw-smallcaps" style={{ fontSize: 9.5 }}>
            The chronicle
          </span>
        )}
        {wide && (
          <span className="sw-folio" style={{ marginLeft: 'auto' }}>
            v
          </span>
        )}
      </div>
      <hr className="sw-rule-solid" style={{ margin: '0 12px 10px' }} />

      <div
        className="sw-scroll"
        style={{ flex: 1, overflowY: 'auto', position: 'relative' }}
      >
        <div style={{ position: 'relative', paddingLeft: wide ? 28 : 26 }}>
          <div
            style={{
              position: 'absolute',
              left: wide ? 18 : 16,
              top: 4,
              bottom: 4,
              width: 1,
              background: 'var(--rule-soft)',
            }}
          />
          {events.map((e) => {
            const c = dotColor[e.kind];
            const active = e.id === activeId;
            const padTop = 6;
            const padBottom = wide ? 8 : 6;
            const padRight = wide ? 12 : 0;
            const padLeft = active ? (wide ? 6 : 4) : 0;
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
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: wide ? -16 : -12,
                    top: 9,
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: 'var(--vellum)',
                    border: `1.5px solid ${c}`,
                    animation: e.running ? 'sw-pulse 1.4s infinite' : 'none',
                  }}
                />
                {wide ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span className="sw-folio" style={{ fontSize: 9.5 }}>
                        {e.t}
                      </span>
                      {e.awaits && (
                        <span
                          className="sw-smallcaps"
                          style={{ fontSize: 8.5, color: 'var(--gold)' }}
                        >
                          asks
                        </span>
                      )}
                      {e.running && (
                        <span
                          className="sw-smallcaps"
                          style={{ fontSize: 8.5, color: 'var(--ember)' }}
                        >
                          now
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--serif-body)',
                        fontSize: 12.5,
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
                        fontSize: 9.5,
                        color: 'var(--ink-faint)',
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
                    style={{ fontSize: 9, display: 'block', textAlign: 'center' }}
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
          padding: wide ? '8px 12px 0' : '8px 8px 0',
          borderTop: '1px solid var(--rule-soft)',
        }}
      >
        <button
          className="sw-btn"
          onClick={onNew}
          style={{
            width: '100%',
            fontSize: 11.5,
            padding: wide ? '5px 8px' : '5px 0',
            fontFamily: 'var(--serif-display)',
            fontStyle: 'italic',
          }}
        >
          {wide ? '+ a new errand' : '+'}
        </button>
      </div>
    </aside>
  );
}
