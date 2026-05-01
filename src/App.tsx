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
import { useCommands } from './hooks/useCommands';
import { useLive } from './hooks/useLive';
import { useLiveBranch } from './hooks/useLiveBranch';
import { useTheme } from './hooks/useTheme';
import { ASSISTANT_HUB } from './data/mock';

type View = 'threshold' | 'conversation';

// Persist the active conversation across page reloads so a phone lock /
// browser refresh / network blip lands you back where you were and the
// server-side event buffer can replay the missed turn output.
const ACTIVE_KEY = 'samwise-2:active';
const CHRONICLE_COLLAPSED_KEY = 'samwise-2:chronicle-collapsed';
type ActiveSession = { cli: CompanionId; repoPath: string };

function readActive(): ActiveSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      v && (v.cli === 'claude' || v.cli === 'codex' || v.cli === 'assistant')
      && typeof v.repoPath === 'string'
    ) return v;
    return null;
  } catch { return null; }
}

function writeActive(v: ActiveSession | null): void {
  if (typeof window === 'undefined') return;
  if (v) localStorage.setItem(ACTIVE_KEY, JSON.stringify(v));
  else localStorage.removeItem(ACTIVE_KEY);
}

function readChronicleCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(CHRONICLE_COLLAPSED_KEY) === '1';
}

const COMPANION_LABEL: Record<CompanionId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  assistant: 'Assistant',
};

function basenameOfPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export default function App() {
  const isMobile = useIsMobile();
  const { theme, toggle: toggleTheme } = useTheme();
  const reposState = useRepos();
  const repos = reposState.repos;
  const reposLoading = reposState.status === 'loading';

  const [chronicleTick, setChronicleTick] = useState(0);
  const chronicle = useChronicle(chronicleTick);
  const commands = useCommands();
  const liveSessions = useLive();

  // Restore the last active conversation if there was one. We start in the
  // threshold view; once /api/repos resolves we bind the saved repoPath to
  // the matching Repo object and switch to conversation.
  const initialActive = readActive();
  const [view, setView] = useState<View>(initialActive ? 'conversation' : 'threshold');
  const [companion, setCompanion] = useState<CompanionId>(initialActive?.cli ?? 'claude');
  const [repo, setRepo] = useState<Repo | undefined>(undefined);
  const restorePathRef = useRef<string | null>(initialActive?.repoPath ?? null);
  const [chronicleOpen, setChronicleOpen] = useState(false);
  const [chronicleCollapsed, setChronicleCollapsed] = useState(readChronicleCollapsed);
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

  // Once repos load, bind the restore-target path to a real Repo object.
  useEffect(() => {
    if (!restorePathRef.current || repo) return;
    if (repos.length === 0) return;
    const target = repos.find((r) => r.path === restorePathRef.current);
    if (target) {
      setRepo(target);
      restorePathRef.current = null;
    } else if (!reposLoading) {
      // Repo was removed since we saved the active session — drop it.
      restorePathRef.current = null;
      writeActive(null);
      setView('threshold');
    }
  }, [repos, reposLoading, repo]);

  // Track the live branch for the active repo so `git checkout` mid-chat
  // updates the header chip and the chat-input footer in real time.
  const liveBranch = useLiveBranch(repo?.path);

  // Refresh the chronicle whenever a turn finishes — Sam may have just
  // written a new session file we haven't seen. Same hook also re-checks
  // the branch (a turn may have switched it).
  const prevStatusRef = useRef(chat.status);
  useEffect(() => {
    if (prevStatusRef.current === 'streaming' && chat.status === 'ready') {
      setChronicleTick((t) => t + 1);
      liveBranch.refresh();
    }
    prevStatusRef.current = chat.status;
  }, [chat.status, liveBranch]);

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
    if (r) writeActive({ cli: c, repoPath: r.path });
    else writeActive(null);
  };

  const repoForPath = (path: string, name?: string): Repo => {
    const known = repos.find((r) => r.path === path);
    return known ? { ...known } : { path, name: name || basenameOfPath(path), hub: 'Live' };
  };

  const openLiveSession = (s: { cli: CompanionId; cwd: string; repoName: string }) => {
    setActiveEventId(null);
    setForth({ companion: s.cli, repo: repoForPath(s.cwd, s.repoName) });
  };

  const openChronicleEvent = async (id: string) => {
    const ev = chronicle.events.find((e) => e.id === id);
    if (!ev) return;
    setActiveEventId(id);

    if (!ev.cwd) {
      setView('conversation');
      return;
    }

    const c: CompanionId = ev.cwd === ASSISTANT_HUB.path ? 'assistant' : 'claude';
    try {
      const r = await fetch('/api/session/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli: c, cwd: ev.cwd, sessionId: ev.id }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.warn('failed to activate chronicle session', e);
    }

    setForth({ companion: c, repo: repoForPath(ev.cwd, ev.repo) });
    setErrandTitle(ev.title || 'a fresh errand');
  };

  const goToThreshold = () => {
    setView('threshold');
    writeActive(null);
  };

  const branchForLabel = liveBranch.branch ?? repo?.branch;
  const repoLabel = repo
    ? `${repo.name}${branchForLabel ? ` · ${branchForLabel}` : ''}`
    : 'just chatting';
  const commandPrefix = companion === 'codex' ? '$' : '/';
  const activeCommands = companion === 'codex' ? commands.codex : commands.claude;

  const appClass = `sw-app sw-paper${theme === 'dark' ? ' sw-dark' : ''}`;

  useEffect(() => {
    localStorage.setItem(CHRONICLE_COLLAPSED_KEY, chronicleCollapsed ? '1' : '0');
  }, [chronicleCollapsed]);

  if (isMobile) {
    return (
      <div className={appClass}>
        {view === 'threshold' ? (
          <MobileThreshold
            repos={repos}
            reposLoading={reposLoading}
            onSetForth={setForth}
            liveSessions={liveSessions}
            onSelectLive={(s) => {
              openLiveSession(s);
            }}
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
            usage={chat.usage}
            commands={activeCommands}
            commandPrefix={commandPrefix}
            onBack={goToThreshold}
            onOpenChronicle={() => setChronicleOpen(true)}
            onSend={chat.send}
            onSteer={chat.steer}
            onFreshStart={chat.freshStart}
            onStop={chat.stop}
            acceptImages={true}
          />
        )}
        <MobileChronicleSheet
          events={chronicle.events}
          open={chronicleOpen}
          onClose={() => setChronicleOpen(false)}
          onSelect={(id) => {
            setChronicleOpen(false);
            void openChronicleEvent(id);
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
        collapsed={chronicleCollapsed}
        onToggleCollapsed={() => setChronicleCollapsed((v) => !v)}
        liveSessions={liveSessions}
        onSelectLive={(s) => {
          openLiveSession(s);
        }}
        onSelect={(id) => {
          void openChronicleEvent(id);
        }}
        onNew={() => setView('threshold')}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
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
            usage={chat.usage}
            commands={activeCommands}
            commandPrefix={commandPrefix}
            onSend={chat.send}
            onSteer={chat.steer}
            onBack={goToThreshold}
            onFreshStart={chat.freshStart}
            onStop={chat.stop}
            acceptImages={true}
          />
        )}
      </main>
    </div>
  );
}
