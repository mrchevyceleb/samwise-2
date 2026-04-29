import { useEffect, useRef, useState } from 'react';
import { Threshold } from './components/desktop/Threshold';
import { Conversation } from './components/desktop/Conversation';
import { ChronicleRibbon } from './components/desktop/ChronicleRibbon';
import {
  MobileThreshold,
  MobileConversation,
  MobileChronicleSheet,
} from './components/mobile/Mobile';
import type { CompanionId, Repo } from './data/types';
import { useIsMobile } from './hooks/useMediaQuery';
import { useRepos } from './hooks/useRepos';
import { useChat } from './hooks/useChat';
import { useChronicle } from './hooks/useChronicle';
import { useTheme } from './hooks/useTheme';

type View = 'threshold' | 'conversation';

const COMPANION_LABEL: Record<CompanionId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  assistant: 'Assistant',
};

export default function App() {
  const isMobile = useIsMobile();
  const { theme, toggle: toggleTheme } = useTheme();
  const reposState = useRepos();
  const repos = reposState.repos;
  const reposLoading = reposState.status === 'loading';

  const [chronicleTick, setChronicleTick] = useState(0);
  const chronicle = useChronicle(chronicleTick);

  const [view, setView] = useState<View>('threshold');
  const [companion, setCompanion] = useState<CompanionId>('claude');
  const [repo, setRepo] = useState<Repo | undefined>(undefined);
  const [chronicleOpen, setChronicleOpen] = useState(false);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [errandTitle, setErrandTitle] = useState('a fresh errand');
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);

  const chat = useChat({
    repo,
    cli: companion,
    enabled: view === 'conversation' && !!repo,
    initialMessage: pendingFirstMessage,
    onInitialMessageSent: () => setPendingFirstMessage(null),
  });

  // Refresh the chronicle whenever a turn finishes — Sam may have just
  // written a new session file we haven't seen.
  const prevStatusRef = useRef(chat.status);
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && chat.status === 'ready') {
      setChronicleTick((t) => t + 1);
    }
    prevStatusRef.current = chat.status;
  }, [chat.status]);

  // Derive a title from the user's first message in the chat.
  useEffect(() => {
    const firstUser = chat.blocks.find((b) => b.kind === 'user');
    if (firstUser && firstUser.kind === 'user') {
      const t = firstUser.text.trim().split('\n')[0].slice(0, 60);
      if (t) setErrandTitle(t);
    } else if (view === 'conversation' && chat.blocks.length === 0) {
      setErrandTitle('a fresh errand');
    }
  }, [chat.blocks, view]);

  const setForth = ({
    companion: c,
    repo: r,
    initialMessage,
  }: { companion: CompanionId; repo?: Repo; initialMessage?: string }) => {
    setCompanion(c);
    setRepo(r);
    setView('conversation');
    setErrandTitle('a fresh errand');
    setPendingFirstMessage(initialMessage ?? null);
  };

  const repoLabel = repo
    ? `${repo.name}${repo.branch ? ` · ${repo.branch}` : ''}`
    : 'just chatting';

  const appClass = `sw-app sw-paper${theme === 'dark' ? ' sw-dark' : ''}`;

  if (isMobile) {
    return (
      <div className={appClass}>
        {view === 'threshold' ? (
          <MobileThreshold
            repos={repos}
            reposLoading={reposLoading}
            onSetForth={setForth}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
        ) : (
          <MobileConversation
            agent={COMPANION_LABEL[companion]}
            repo={repoLabel}
            title={errandTitle}
            blocks={chat.blocks}
            status={chat.status}
            errorText={chat.error}
            onBack={() => setView('threshold')}
            onOpenChronicle={() => setChronicleOpen(true)}
            onSend={chat.send}
          />
        )}
        <MobileChronicleSheet
          events={chronicle.events}
          open={chronicleOpen}
          onClose={() => setChronicleOpen(false)}
          onSelect={(id) => {
            setActiveEventId(id);
            setChronicleOpen(false);
            setView('conversation');
          }}
          onNew={() => {
            setChronicleOpen(false);
            setView('threshold');
          }}
        />
      </div>
    );
  }

  return (
    <div className={appClass} style={{ flexDirection: 'row' }}>
      <ChronicleRibbon
        events={chronicle.events}
        activeId={view === 'conversation' ? activeEventId : null}
        collapsed={view === 'threshold'}
        onSelect={(id) => {
          setActiveEventId(id);
          setView('conversation');
        }}
        onNew={() => setView('threshold')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {view === 'threshold' ? (
          <Threshold
            repos={repos}
            reposLoading={reposLoading}
            onSetForth={setForth}
          />
        ) : (
          <Conversation
            agent={COMPANION_LABEL[companion]}
            repo={repoLabel}
            title={errandTitle}
            blocks={chat.blocks}
            status={chat.status}
            errorText={chat.error}
            onSend={chat.send}
            onBack={() => setView('threshold')}
          />
        )}
      </main>
    </div>
  );
}
