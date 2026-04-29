import { useState } from 'react';
import type { ReactNode } from 'react';
import { SamPortrait } from './atoms';

// ─────────────────────────────────────────────
// Sam's message bubble — vellum, left-aligned, with avatar
// ─────────────────────────────────────────────
export function SamMessage({
  children,
  time,
  folio,
}: { children: ReactNode; time?: string; folio?: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 18 }}>
      <SamPortrait size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'baseline',
            marginBottom: 5,
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--serif-display)',
              fontStyle: 'italic',
              fontSize: 14,
              color: 'var(--ink-2)',
              whiteSpace: 'nowrap',
            }}
          >
            Samwise
          </span>
          {time && (
            <span className="sw-folio" style={{ whiteSpace: 'nowrap' }}>
              {time}
            </span>
          )}
          {folio && (
            <span
              className="sw-folio"
              style={{ marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {folio}
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: 'var(--serif-body)',
            fontSize: 15.5,
            lineHeight: 1.55,
            color: 'var(--ink)',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// User's message — ink-toned, right-aligned, no avatar
// ─────────────────────────────────────────────
export function UserMessage({
  children,
  time,
}: { children: ReactNode; time?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 18 }}>
      <div style={{ maxWidth: '85%' }}>
        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'baseline',
            marginBottom: 5,
            justifyContent: 'flex-end',
          }}
        >
          {time && (
            <span className="sw-folio" style={{ whiteSpace: 'nowrap' }}>
              {time}
            </span>
          )}
          <span className="sw-smallcaps" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            You
          </span>
        </div>
        <div
          style={{
            background: 'var(--ink)',
            color: 'var(--vellum)',
            padding: '10px 14px',
            borderRadius: 14,
            fontFamily: 'var(--serif-body)',
            fontSize: 15.5,
            lineHeight: 1.5,
            boxShadow: '0 1px 0 var(--shadow-warm)',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ToolCall — quoted ledger excerpt
// ─────────────────────────────────────────────
export function ToolCall({
  tool,
  args,
  result,
  status = 'done',
  running = false,
}: {
  tool: string;
  args?: string;
  result?: string;
  status?: 'done' | string;
  running?: boolean;
}) {
  return (
    <div
      style={{
        borderLeft: '2px solid var(--rule)',
        paddingLeft: 12,
        marginTop: 8,
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <span
          className="sw-smallcaps"
          style={{ fontSize: 10, color: 'var(--ember)' }}
        >
          {running ? 'Running' : status === 'done' ? 'Ran' : status}
        </span>
        <span className="sw-mono" style={{ color: 'var(--ink-2)', fontSize: 12 }}>
          {tool}
        </span>
        {args && (
          <span className="sw-mono" style={{ color: 'var(--ink-faint)', fontSize: 12 }}>
            ({args})
          </span>
        )}
        {running && (
          <span className="sw-thinking" style={{ marginLeft: 'auto' }}>
            <span></span>
            <span></span>
            <span></span>
          </span>
        )}
      </div>
      {result && (
        <div
          className="sw-mono"
          style={{ color: 'var(--ink-soft)', fontSize: 12, paddingLeft: 0 }}
        >
          {result}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// CodeBlock — ledger-line gutter
// ─────────────────────────────────────────────
export function CodeBlock({
  children,
  lang,
}: { children: string; lang?: string }) {
  const lines = children.split('\n');
  return (
    <div
      style={{
        background: 'var(--vellum)',
        border: '1px solid var(--rule-soft)',
        borderRadius: 2,
        margin: '10px 0',
        overflow: 'hidden',
      }}
    >
      {lang && (
        <div
          style={{
            padding: '4px 12px',
            borderBottom: '1px solid var(--rule-soft)',
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            color: 'var(--ink-faint)',
            letterSpacing: '0.06em',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>{lang}</span>
          <span
            style={{
              fontStyle: 'italic',
              fontFamily: 'var(--serif-display)',
              fontSize: 12,
            }}
          >
            {lines.length} lines
          </span>
        </div>
      )}
      <div style={{ padding: '8px 0', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.65 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: 'flex' }}>
            <span
              style={{
                minWidth: 36,
                textAlign: 'right',
                paddingRight: 12,
                color: 'var(--ink-faint)',
                userSelect: 'none',
                fontStyle: 'italic',
                fontFamily: 'var(--serif-display)',
                fontSize: 11,
              }}
            >
              {i + 1}
            </span>
            <span
              style={{
                flex: 1,
                paddingRight: 12,
                whiteSpace: 'pre',
                color: 'var(--ink)',
              }}
            >
              {line || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// DiffBlock
// ─────────────────────────────────────────────
export type DiffHunk = { t?: '+' | '-' | ' '; n?: number | string; l: string };

export function DiffBlock({
  filename,
  additions,
  deletions,
  hunks,
}: {
  filename: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}) {
  return (
    <div
      style={{
        background: 'var(--vellum)',
        border: '1px solid var(--rule-soft)',
        borderRadius: 2,
        margin: '10px 0',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          borderBottom: '1px solid var(--rule-soft)',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span style={{ color: 'var(--ink-2)' }}>{filename}</span>
        <span style={{ color: 'var(--moss)' }}>+{additions}</span>
        <span style={{ color: 'var(--ember)' }}>−{deletions}</span>
      </div>
      <div style={{ padding: '6px 0', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}>
        {hunks.map((h, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              background:
                h.t === '+'
                  ? 'rgba(111,128,84,0.08)'
                  : h.t === '-'
                    ? 'rgba(184,89,58,0.07)'
                    : 'transparent',
            }}
          >
            <span
              style={{
                minWidth: 28,
                textAlign: 'right',
                paddingRight: 8,
                color: 'var(--ink-faint)',
                userSelect: 'none',
                fontSize: 11,
              }}
            >
              {h.n || ''}
            </span>
            <span
              style={{
                minWidth: 14,
                textAlign: 'center',
                color:
                  h.t === '+' ? 'var(--moss)' : h.t === '-' ? 'var(--ember)' : 'var(--ink-faint)',
              }}
            >
              {h.t || ' '}
            </span>
            <span style={{ flex: 1, paddingRight: 12, whiteSpace: 'pre', color: 'var(--ink)' }}>
              {h.l}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ChatInput — quill-and-paper composer
// ─────────────────────────────────────────────
export function ChatInput({
  value,
  onChange,
  onSend,
  placeholder = 'Speak, master.',
  agent = 'Claude Code',
  repo = '',
}: {
  value?: string;
  onChange?: (v: string) => void;
  onSend?: (v: string) => void;
  placeholder?: string;
  agent?: string;
  repo?: string;
}) {
  const [internal, setInternal] = useState(value ?? '');
  const isControlled = value !== undefined;
  const v = isControlled ? value : internal;

  const setV = (next: string) => {
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };

  const submit = () => {
    if (!v.trim()) return;
    onSend?.(v);
    if (!isControlled) setInternal('');
  };

  return (
    <div
      style={{
        background: 'var(--vellum)',
        border: '1px solid var(--rule)',
        borderRadius: 2,
        padding: '12px 14px 10px',
        boxShadow: '0 1px 0 var(--shadow-warm)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          paddingBottom: 6,
          borderBottom: '1px dashed var(--rule-soft)',
        }}
      >
        <span className="sw-smallcaps" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
          Companion
        </span>
        <span
          style={{
            fontFamily: 'var(--serif-display)',
            fontStyle: 'italic',
            fontSize: 13,
            color: 'var(--ink)',
            whiteSpace: 'nowrap',
          }}
        >
          {agent}
        </span>
        {repo && (
          <>
            <span style={{ color: 'var(--ink-faint)' }}>·</span>
            <span
              className="sw-mono"
              style={{
                fontSize: 11.5,
                color: 'var(--ink-soft)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              {repo}
            </span>
          </>
        )}
        <span
          style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}
          className="sw-folio"
        >
          ⌘K to switch
        </span>
      </div>
      <textarea
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={2}
        style={{
          width: '100%',
          resize: 'none',
          border: 0,
          outline: 'none',
          background: 'transparent',
          fontFamily: 'var(--serif-body)',
          fontSize: 15,
          lineHeight: 1.5,
          color: 'var(--ink)',
          fontStyle: v ? 'normal' : 'italic',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span className="sw-folio" style={{ fontStyle: 'italic' }}>
          ↵ to send · ⇧↵ for new line
        </span>
        <span style={{ marginLeft: 'auto' }}></span>
        <button className="sw-btn" style={{ fontSize: 12, padding: '4px 10px' }}>
          Attach
        </button>
        <button
          className="sw-btn sw-btn-primary"
          style={{ fontSize: 12, padding: '4px 14px' }}
          onClick={submit}
        >
          Send
        </button>
      </div>
    </div>
  );
}
