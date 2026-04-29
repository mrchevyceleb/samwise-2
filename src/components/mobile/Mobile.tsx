import { useEffect, useRef, useState } from 'react';
import { SamPortrait, Dinkus, Chip, SearchGlyph } from '../primitives/atoms';
import {
  SamMessage,
  UserMessage,
  ToolCall,
} from '../primitives/chat';

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
import {
  COMPANIONS,
  SPECIAL_REPOS,
  HUBS,
  STATS,
  CHRONICLE,
  ASSISTANT_HUB,
  type CompanionId,
  type Repo,
  type Hub,
  type ChronicleEvent,
  type ChronicleEventKind,
} from '../../data/mock';

// ─── Mobile Threshold ───
export function MobileThreshold({
  repos,
  reposLoading,
  onSetForth,
}: {
  repos: Repo[];
  reposLoading?: boolean;
  onSetForth: (params: { companion: CompanionId; repo?: Repo }) => void;
}) {
  const [companion, setCompanion] = useState<CompanionId>('claude');
  const liveAssistantHub = repos.find((r) => r.isAssistantHub) ?? ASSISTANT_HUB;
  const regularRepos = repos.filter((r) => !r.isAssistantHub);
  const [selectedRepo, setSelectedRepo] = useState<Repo | undefined>(undefined);
  const [query, setQuery] = useState('');

  if (selectedRepo === undefined && companion !== 'assistant' && regularRepos.length > 0) {
    setSelectedRepo(regularRepos[0]);
  }

  const pickCompanion = (id: CompanionId) => {
    setCompanion(id);
    if (id === 'assistant') setSelectedRepo(liveAssistantHub);
  };

  const effectiveRepo = companion === 'assistant' ? liveAssistantHub : selectedRepo;

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '28px 22px 40px',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          padding: 5,
          background: 'var(--vellum)',
          border: '1px solid var(--rule)',
          borderRadius: '50%',
          boxShadow: '0 1px 0 var(--shadow-warm), 0 0 28px rgba(184,89,58,0.10)',
          marginBottom: 14,
        }}
      >
        <SamPortrait size={72} ring={false} />
      </div>
      <div className="sw-folio" style={{ marginBottom: 4, letterSpacing: '0.18em' }}>
        · vol. ii ·
      </div>
      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--serif-display)',
          fontSize: 44,
          fontWeight: 500,
          lineHeight: 0.95,
          color: 'var(--ink)',
          letterSpacing: '-0.01em',
        }}
      >
        Samwise
      </h1>
      <p
        style={{
          margin: '10px 0 0',
          fontFamily: 'var(--serif-display)',
          fontStyle: 'italic',
          fontSize: 15.5,
          color: 'var(--ink-soft)',
          textAlign: 'center',
          maxWidth: 280,
        }}
      >
        At your service, master.
        <span style={{ color: 'var(--ink-faint)' }}> Whither this morning?</span>
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 22, alignItems: 'center' }}>
        <PStat n={STATS.underway} l="underway" tone="ember" />
        <span style={{ width: 1, height: 30, background: 'var(--rule-soft)' }} />
        <PStat n={STATS.awaits} l="awaits" tone="gold" />
        <span style={{ width: 1, height: 30, background: 'var(--rule-soft)' }} />
        <PStat n={STATS.finished} l="finished" tone="moss" />
      </div>

      {/* Palette card */}
      <div
        style={{
          width: '100%',
          marginTop: 22,
          background: 'var(--vellum)',
          border: '1px solid var(--rule)',
          borderRadius: 4,
          boxShadow: '0 1px 0 var(--shadow-warm)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--rule-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <SearchGlyph size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="speak, or pick below…"
            style={{
              flex: 1,
              border: 0,
              outline: 'none',
              background: 'transparent',
              fontFamily: 'var(--serif-display)',
              fontStyle: query ? 'normal' : 'italic',
              fontSize: 15,
              color: query ? 'var(--ink)' : 'var(--ink-faint)',
            }}
          />
        </div>

        <div style={{ padding: '12px 14px 6px' }}>
          <PSectionLabel folio="i" label="your companion" />
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            {COMPANIONS.map((c) => (
              <PCompanion
                key={c.id}
                name={c.name}
                selected={c.id === companion}
                onSelect={() => pickCompanion(c.id)}
              />
            ))}
          </div>
        </div>
        <hr style={{ border: 0, height: 1, background: 'var(--rule-soft)', margin: 0 }} />
        <div style={{ padding: '12px 14px 8px' }}>
          <PSectionLabel
            folio="ii"
            label={
              companion === 'assistant' ? 'tending the hub' : 'where shall we work?'
            }
          />
          {companion === 'assistant' ? (
            <div
              style={{
                padding: '6px 8px',
                borderLeft: '2px solid var(--ember)',
                background: 'rgba(184,89,58,0.08)',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span
                className="sw-mono"
                style={{
                  fontSize: 12,
                  color: 'var(--ink)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: 1,
                  minWidth: 0,
                }}
              >
                ASSISTANT-HUB
              </span>
              <span
                className="sw-mono"
                style={{ fontSize: 10, color: 'var(--ember)', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                · master
              </span>
              <span
                className="sw-folio"
                style={{ whiteSpace: 'nowrap', flexShrink: 0, fontStyle: 'italic' }}
              >
                always at hand
              </span>
            </div>
          ) : reposLoading && regularRepos.length === 0 ? (
            <div
              className="sw-folio"
              style={{ padding: '6px 4px', fontStyle: 'italic' }}
            >
              scanning the shelves…
            </div>
          ) : (
            <>
              {regularRepos.map((r) => (
                <PRepo
                  key={r.path}
                  repo={r}
                  selected={r.path === selectedRepo?.path}
                  onClick={() => setSelectedRepo(r)}
                />
              ))}
              {SPECIAL_REPOS.map((r) => (
                <PRepo
                  key={r.path}
                  repo={r}
                  selected={false}
                  onClick={() => setSelectedRepo(undefined)}
                />
              ))}
            </>
          )}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--rule-soft)',
            background: 'var(--parchment-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span className="sw-folio" style={{ fontStyle: 'italic', fontSize: 10.5 }}>
            tap to set forth
          </span>
          <span style={{ marginLeft: 'auto' }} />
          <button
            className="sw-btn sw-btn-primary"
            onClick={() => onSetForth({ companion, repo: effectiveRepo })}
            style={{
              fontSize: 13,
              padding: '6px 16px',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              fontFamily: 'var(--serif-display)',
              fontStyle: 'italic',
            }}
          >
            Set forth ↵
          </button>
        </div>
      </div>

      {/* Hubs */}
      <div
        style={{
          width: '100%',
          marginTop: 18,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span className="sw-smallcaps" style={{ fontSize: 9.5, whiteSpace: 'nowrap' }}>
          or, a hub
        </span>
        <span style={{ flex: 1, height: 1, background: 'var(--rule-soft)' }} />
        <span className="sw-folio" style={{ fontStyle: 'italic' }}>
          iii
        </span>
      </div>
      <div
        style={{
          width: '100%',
          marginTop: 8,
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        {HUBS.map((h) => (
          <PPill key={h.name} hub={h} />
        ))}
      </div>
    </div>
  );
}

// ─── Mobile Conversation ───
export function MobileConversation({
  agent = 'Claude Code',
  repo = '',
  title = 'a fresh errand',
  blocks,
  status,
  errorText,
  onBack,
  onOpenChronicle,
  onSend,
}: {
  agent?: string;
  repo?: string;
  title?: string;
  blocks: import('../../data/types').ChatBlock[];
  status: 'idle' | 'connecting' | 'ready' | 'streaming' | 'closed' | 'error';
  errorText?: string | null;
  onBack: () => void;
  onOpenChronicle: () => void;
  onSend?: (message: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length, status]);

  const submit = () => {
    if (!draft.trim()) return;
    onSend?.(draft);
    setDraft('');
  };

  const statusLabel: Record<typeof status, string> = {
    idle: 'idle',
    connecting: 'kindling',
    ready: 'at hand',
    streaming: 'tending',
    closed: 'asleep',
    error: 'troubled',
  };
  const statusTone: Record<typeof status, 'ember' | 'moss' | 'gold' | 'neutral'> = {
    idle: 'neutral',
    connecting: 'gold',
    ready: 'moss',
    streaming: 'ember',
    closed: 'neutral',
    error: 'gold',
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--parchment)',
        position: 'relative',
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '12px 16px 10px',
          borderBottom: '1px solid var(--rule-soft)',
          background: 'var(--vellum)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 0,
            padding: 0,
            fontFamily: 'var(--serif-display)',
            fontStyle: 'italic',
            fontSize: 14,
            color: 'var(--ember)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
            cursor: 'pointer',
          }}
        >
          ← errands
        </button>
        <SamPortrait size={22} />
        <span
          style={{
            fontFamily: 'var(--serif-display)',
            fontStyle: 'italic',
            fontSize: 14,
            color: 'var(--ink-2)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
        >
          {title}
        </span>
        <Chip dot tone={statusTone[status]}>
          {statusLabel[status]}
        </Chip>
      </div>

      {/* Reading column */}
      <div
        ref={scrollRef}
        className="sw-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '18px 20px 10px',
          background: 'var(--vellum)',
        }}
      >
        <div className="sw-folio" style={{ textAlign: 'center', marginBottom: 6 }}>
          {agent.toLowerCase()} · {repo}
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--serif-display)',
            fontSize: 26,
            fontWeight: 500,
            color: 'var(--ink)',
            textAlign: 'center',
            lineHeight: 1.05,
          }}
        >
          <span style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}>Of </span>
          {title}
        </h1>
        <div className="sw-ornament" style={{ margin: '14px 0 18px' }}>
          <Dinkus />
        </div>

        {blocks.length === 0 && status !== 'streaming' && (
          <p
            style={{
              fontFamily: 'var(--serif-display)',
              fontStyle: 'italic',
              color: 'var(--ink-faint)',
              textAlign: 'center',
              margin: '24px 0',
              fontSize: 14,
            }}
          >
            Speak, master, and I shall set forth.
          </p>
        )}

        {blocks.map((b) => {
          if (b.kind === 'user') {
            return (
              <UserMessage key={b.id} time={timeLabel(b.ts)}>
                {b.text}
              </UserMessage>
            );
          }
          if (b.kind === 'text') {
            return (
              <SamMessage key={b.id} time={timeLabel(b.ts)}>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{b.text}</p>
              </SamMessage>
            );
          }
          return (
            <SamMessage key={b.id} time={timeLabel(b.ts)}>
              <ToolCall
                tool={b.tool}
                args={b.args}
                result={b.result}
                running={b.running}
                status={b.running ? 'running' : 'done'}
              />
            </SamMessage>
          );
        })}

        {status === 'streaming' && blocks.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <span className="sw-thinking">
              <span></span>
              <span></span>
              <span></span>
            </span>
          </div>
        )}

        {errorText && (
          <p
            style={{
              fontFamily: 'var(--serif-body)',
              fontStyle: 'italic',
              color: 'var(--ember)',
              textAlign: 'center',
              margin: '8px 0',
              fontSize: 13,
            }}
          >
            {errorText}
          </p>
        )}

        <div style={{ height: 8 }} />
      </div>

      {/* Composer */}
      <div
        style={{
          padding: '8px 14px 12px',
          borderTop: '1px solid var(--rule-soft)',
          background: 'var(--parchment-2)',
        }}
      >
        <div
          style={{
            background: 'var(--vellum)',
            borderRadius: 18,
            border: '1px solid var(--rule-soft)',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="speak, master…"
            style={{
              flex: 1,
              border: 0,
              outline: 'none',
              background: 'transparent',
              fontFamily: 'var(--serif-body)',
              fontStyle: draft ? 'normal' : 'italic',
              color: draft ? 'var(--ink)' : 'var(--ink-faint)',
              fontSize: 14,
            }}
          />
          <button
            onClick={submit}
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              border: 0,
              background: 'var(--ink)',
              color: 'var(--vellum)',
              fontFamily: 'var(--serif-display)',
              fontSize: 16,
              fontStyle: 'italic',
              cursor: 'pointer',
            }}
          >
            ↑
          </button>
        </div>
      </div>

      {/* Chronicle FAB */}
      <button
        onClick={onOpenChronicle}
        aria-label="Open chronicle"
        style={{
          position: 'absolute',
          right: 14,
          bottom: 76,
          width: 50,
          height: 50,
          borderRadius: '50%',
          background: 'var(--vellum)',
          border: '1.5px solid var(--rule)',
          boxShadow: '0 4px 14px rgba(74,50,24,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--ember)',
            border: '2px solid var(--vellum)',
            animation: 'sw-pulse 1.4s infinite',
            position: 'absolute',
            top: 4,
            right: 4,
            zIndex: 2,
          }}
        />
        <SamPortrait size={46} ring={false} />
      </button>

      {/* Repo info subhead — kept minimal so chrome stays out of the way */}
      <span style={{ display: 'none' }}>{`${agent}·${repo}`}</span>
    </div>
  );
}

// ─── Mobile Chronicle Sheet ───
export function MobileChronicleSheet({
  events,
  open,
  onClose,
  onSelect,
  onNew,
}: {
  events: ChronicleEvent[];
  open: boolean;
  onClose: () => void;
  onSelect?: (id: string) => void;
  onNew?: () => void;
}) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--parchment)',
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          boxShadow: '0 -16px 40px rgba(74,50,24,0.25)',
          padding: '10px 0 28px',
          maxHeight: '80%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
          <span
            style={{
              width: 38,
              height: 4,
              borderRadius: 2,
              background: 'var(--rule)',
            }}
          />
        </div>
        <div
          style={{
            padding: '4px 22px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <SamPortrait size={28} />
          <h2
            style={{
              margin: 0,
              fontFamily: 'var(--serif-display)',
              fontSize: 22,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            <span style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}>The </span>
            Chronicle
          </h2>
          <span
            style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}
            className="sw-folio"
          >
            {events.length} today
          </span>
        </div>
        <hr className="sw-rule-solid" style={{ margin: '0 22px 0' }} />

        <div
          className="sw-scroll"
          style={{ flex: 1, overflowY: 'auto', padding: '14px 22px 0' }}
        >
          {events.map((e) => (
            <PChronicleRow key={e.id} e={e} onSelect={onSelect} />
          ))}
        </div>

        <div
          style={{ padding: '10px 22px 0', borderTop: '1px solid var(--rule-soft)' }}
        >
          <button
            className="sw-btn sw-btn-primary"
            onClick={onNew}
            style={{
              width: '100%',
              fontSize: 16,
              padding: '12px',
              whiteSpace: 'nowrap',
              fontFamily: 'var(--serif-display)',
              fontStyle: 'italic',
              letterSpacing: '0.02em',
            }}
          >
            + a new errand
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mobile atoms ───
function PStat({
  n,
  l,
  tone,
}: { n: number | string; l: string; tone: 'ember' | 'moss' | 'gold' }) {
  const colors = {
    ember: 'var(--ember)',
    moss: 'var(--moss)',
    gold: 'var(--gold)',
  } as const;
  return (
    <div style={{ textAlign: 'center', minWidth: 60 }}>
      <div
        style={{
          fontFamily: 'var(--serif-display)',
          fontSize: 26,
          fontWeight: 500,
          lineHeight: 1,
          color: colors[tone],
        }}
      >
        {n}
      </div>
      <div
        className="sw-smallcaps"
        style={{ fontSize: 9, marginTop: 2, whiteSpace: 'nowrap' }}
      >
        {l}
      </div>
    </div>
  );
}

function PSectionLabel({ folio, label }: { folio: string; label: string }) {
  return (
    <div
      className="sw-smallcaps"
      style={{ fontSize: 9.5, marginBottom: 7, whiteSpace: 'nowrap' }}
    >
      <span className="sw-folio" style={{ marginRight: 6 }}>
        {folio}
      </span>
      {label}
    </div>
  );
}

function PCompanion({
  name,
  selected,
  onSelect,
}: { name: string; selected?: boolean; onSelect?: () => void }) {
  return (
    <div
      onClick={onSelect}
      style={{
        flex: 1,
        padding: '8px 8px',
        background: selected ? 'var(--ink)' : 'var(--vellum)',
        color: selected ? 'var(--vellum)' : 'var(--ink)',
        border: '1px solid ' + (selected ? 'var(--ink)' : 'var(--rule-soft)'),
        borderRadius: 12,
        textAlign: 'center',
        fontFamily: 'var(--serif-display)',
        fontSize: 13,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        cursor: 'pointer',
      }}
    >
      {name}
    </div>
  );
}

function PRepo({
  repo,
  selected,
  onClick,
}: { repo: Repo; selected?: boolean; onClick?: () => void }) {
  const { branch, recent, pinned, italic, awaits } = repo;
  const label = italic ? repo.name : repo.name;
  return (
    <div
      onClick={onClick}
      title={repo.path}
      style={{
        padding: '6px 8px',
        background: selected ? 'rgba(184,89,58,0.08)' : 'transparent',
        borderLeft: pinned
          ? '2px solid var(--ember)'
          : awaits
            ? '2px solid var(--gold)'
            : '2px solid transparent',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: italic ? 'var(--ink-soft)' : 'var(--ink)',
          fontStyle: italic ? 'italic' : 'normal',
          fontFamily: italic ? 'var(--serif-display)' : 'var(--mono)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
          flex: '1 1 0',
        }}
      >
        {label}
      </span>
      {branch && (
        <span
          className="sw-mono"
          style={{
            fontSize: 10,
            color: 'var(--ember)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          · {branch}
        </span>
      )}
      {recent && (
        <span
          className="sw-folio"
          style={{
            whiteSpace: 'nowrap',
            flexShrink: 0,
            color: awaits ? 'var(--gold)' : undefined,
            fontStyle: awaits ? 'italic' : undefined,
          }}
        >
          {recent}
        </span>
      )}
    </div>
  );
}

function PPill({ hub }: { hub: Hub }) {
  return (
    <div
      style={{
        padding: '6px 12px',
        background: hub.cozy ? 'var(--parchment-3)' : 'var(--vellum)',
        border: '1px solid var(--rule-soft)',
        borderRadius: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--serif-display)',
          fontSize: 13,
          fontStyle: 'italic',
          whiteSpace: 'nowrap',
        }}
      >
        {hub.name}
      </span>
      <span
        className="sw-mono"
        style={{ fontSize: 10, color: 'var(--ink-faint)' }}
      >
        {hub.count}
      </span>
    </div>
  );
}

function PChronicleRow({
  e,
  onSelect,
}: { e: ChronicleEvent; onSelect?: (id: string) => void }) {
  const colors: Record<ChronicleEventKind, string> = {
    ember: 'var(--ember)',
    gold: 'var(--gold)',
    moss: 'var(--moss)',
    ink: 'var(--ink-faint)',
  };
  const c = colors[e.kind];
  const active = e.running;
  return (
    <div
      onClick={() => onSelect?.(e.id)}
      style={{
        padding: '10px 10px',
        marginBottom: 4,
        background: active ? 'var(--vellum)' : 'transparent',
        borderLeft: active ? '2px solid var(--ember)' : '2px solid transparent',
        borderRadius: 2,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          marginTop: 6,
          background: 'var(--vellum)',
          border: `1.5px solid ${c}`,
          flexShrink: 0,
          animation: e.running ? 'sw-pulse 1.4s infinite' : 'none',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            marginBottom: 2,
          }}
        >
          <span className="sw-folio" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
            {e.t}
          </span>
          {e.running && (
            <span
              className="sw-smallcaps"
              style={{ fontSize: 9, color: 'var(--ember)', whiteSpace: 'nowrap' }}
            >
              tending
            </span>
          )}
          {e.awaits && (
            <span
              className="sw-smallcaps"
              style={{ fontSize: 9, color: 'var(--gold)', whiteSpace: 'nowrap' }}
            >
              asks
            </span>
          )}
          {e.done && (
            <span
              className="sw-smallcaps"
              style={{ fontSize: 9, color: 'var(--moss)', whiteSpace: 'nowrap' }}
            >
              finished
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: 'var(--serif-display)',
            fontSize: 16,
            fontWeight: 500,
            color: 'var(--ink)',
            lineHeight: 1.15,
          }}
        >
          <span style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}>Of the </span>
          {e.title}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
          <span
            className="sw-mono"
            style={{
              fontSize: 10.5,
              color: 'var(--ink-soft)',
              whiteSpace: 'nowrap',
            }}
          >
            {e.repo}
          </span>
          <span style={{ color: 'var(--ink-faint)' }}>·</span>
          <span
            style={{
              fontFamily: 'var(--serif-body)',
              fontSize: 12,
              color: e.awaits ? 'var(--gold)' : 'var(--ink-2)',
              fontStyle: e.awaits ? 'italic' : 'normal',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: 1,
            }}
          >
            {e.status}
          </span>
        </div>
      </div>
    </div>
  );
}

// Re-export for convenience
export { CHRONICLE };
