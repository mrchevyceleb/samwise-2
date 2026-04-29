import { useEffect, useRef } from 'react';
import { SamPortrait, Dinkus, Chip } from '../primitives/atoms';
import {
  SamMessage,
  UserMessage,
  ToolCall,
  ChatInput,
} from '../primitives/chat';
import type { ChatBlock } from '../../data/types';

type Status = 'idle' | 'connecting' | 'ready' | 'streaming' | 'closed' | 'error';

type ConversationProps = {
  agent?: string;
  repo?: string;
  title?: string;
  blocks: ChatBlock[];
  status: Status;
  errorText?: string | null;
  onSend?: (message: string) => void;
  onBack?: () => void;
};

const statusToneByStatus: Record<Status, 'ember' | 'moss' | 'gold' | 'neutral'> = {
  idle: 'neutral',
  connecting: 'gold',
  ready: 'moss',
  streaming: 'ember',
  closed: 'neutral',
  error: 'gold',
};

const statusLabel: Record<Status, string> = {
  idle: 'idle',
  connecting: 'kindling',
  ready: 'at hand',
  streaming: 'tending',
  closed: 'asleep',
  error: 'troubled',
};

export function Conversation({
  agent = 'Claude Code',
  repo = '',
  title = 'a fresh errand',
  blocks,
  status,
  errorText,
  onSend,
}: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length, status]);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--vellum)',
        minWidth: 0,
      }}
    >
      <div
        ref={scrollRef}
        className="sw-scroll"
        style={{ flex: 1, overflowY: 'auto', padding: '20px 0 0' }}
      >
        <div style={{ maxWidth: 660, margin: '0 auto', padding: '0 40px' }}>
          <div
            style={{
              textAlign: 'center',
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <SamPortrait size={36} />
          </div>
          <div className="sw-folio" style={{ textAlign: 'center', marginBottom: 6 }}>
            errand · {todayLabel()}
          </div>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--serif-display)',
              fontSize: 38,
              fontWeight: 500,
              color: 'var(--ink)',
              textAlign: 'center',
              lineHeight: 1.05,
            }}
          >
            <span style={{ fontStyle: 'italic', color: 'var(--ink-soft)' }}>Of </span>
            {title}
          </h1>
          <div
            style={{
              textAlign: 'center',
              marginTop: 8,
              display: 'flex',
              justifyContent: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <Chip dot tone={statusToneByStatus[status]}>
              {statusLabel[status]}
            </Chip>
            <Chip tone="neutral">{agent.toLowerCase()}</Chip>
            {repo && <Chip tone="neutral">{repo}</Chip>}
          </div>
          <div className="sw-ornament" style={{ margin: '24px 0 28px' }}>
            <Dinkus />
          </div>

          {blocks.length === 0 && status !== 'streaming' && (
            <p
              style={{
                fontFamily: 'var(--serif-display)',
                fontStyle: 'italic',
                color: 'var(--ink-faint)',
                textAlign: 'center',
                margin: '32px 0',
              }}
            >
              Speak, master, and I shall set forth.
            </p>
          )}

          {renderBlocks(blocks)}

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
                margin: '12px 0',
              }}
            >
              {errorText}
            </p>
          )}

          <div style={{ height: 28 }} />
        </div>
      </div>

      <div
        style={{
          padding: '14px 0 22px',
          borderTop: '1px solid var(--rule-soft)',
          background: 'var(--vellum)',
        }}
      >
        <div style={{ maxWidth: 660, margin: '0 auto', padding: '0 40px' }}>
          <ChatInput
            agent={agent}
            repo={repo}
            placeholder="speak, master…"
            onSend={onSend}
          />
        </div>
      </div>
    </div>
  );
}

function renderBlocks(blocks: ChatBlock[]) {
  return blocks.map((b) => {
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
    // tool
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
  });
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayLabel(): string {
  const d = new Date();
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const ord = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  return `the ${ord(d.getDate())} of ${months[d.getMonth()]}`;
}
