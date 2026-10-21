import { useCallback, useEffect, useRef, useState } from 'react';
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
import { readStoredBananaModel } from './components/primitives/BananaModelPicker';
import {
  normalizeCodexEffort,
  normalizeCodexModel,
  readStoredCodexEffort,
  readStoredCodexModel,
  writeStoredCodexSelection,
} from './components/primitives/codexModels';
import {
  normalizeClaudeEffort,
  normalizeClaudeModel,
  readSessionClaudeSelection,
  readStoredClaudeEffort,
  readStoredClaudeModel,
  writeSessionClaudeSelection,
  writeStoredClaudeSelection,
} from './components/primitives/claudeModels';
import { readChatPick, writeChatPick } from './data/modelMemory';
import { useLive } from './hooks/useLive';
import { useLiveBranch } from './hooks/useLiveBranch';
import { useTheme } from './hooks/useTheme';
import { ASSISTANT_HUB } from './data/mock';

type View = 'threshold' | 'conversation';

/** Shown for the brief moment a restored conversation waits for the repo
 *  list to say where it lives. Same vellum, same pulse as a live turn. */
function MakingReady({ error = false, onRetry }: { error?: boolean; onRetry?: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
      }}
    >
      {!error && (
        <span className="sw-thinking">
          <span></span>
          <span></span>
          <span></span>
        </span>
      )}
      <span className="sw-folio" style={{ fontStyle: 'italic', fontSize: 13 }}>
        {error ? 'the shelves are out of reach' : 'making ready…'}
      </span>
      {error && onRetry && (
        <button
          className="sw-btn"
          onClick={onRetry}
          style={{ fontSize: 13, padding: '6px 14px', minHeight: 0 }}
        >
          try again
        </button>
      )}
    </div>
  );
}

// Persist the active conversation across page reloads so a phone lock /
// browser refresh / network blip lands you back where you were and the
// server-side event buffer can replay the missed turn output.
const ACTIVE_KEY = 'samwise-2:active';
const CHRONICLE_COLLAPSED_KEY = 'samwise-2:chronicle-collapsed';
const ASSISTANT_ENGINE_KEY = 'samwise-2:assistant-engine';

// The Assistant companion is a "where" (the hub), not a "what" (which CLI).
// We let the user pick which engine drives it. 'claude' keeps the legacy
// 'assistant' cli kind on the wire so existing stored sessions still resume;
// 'codex' / 'banana' morph the companion at the boundary so they go through
// the regular codex/banana runners with cwd set to the hub.
export type AssistantEngine = 'claude' | 'codex' | 'banana';

function readAssistantEngine(): AssistantEngine {
  if (typeof window === 'undefined') return 'claude';
  const v = localStorage.getItem(ASSISTANT_ENGINE_KEY);
  if (v === 'claude' || v === 'codex' || v === 'banana') return v;
  return 'claude';
}

type ActiveSession = {
  cli: CompanionId;
  repoPath: string;
  chatId?: string | null;
  sessionId?: string | null;
};

function readActive(): ActiveSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      v && (v.cli === 'claude' || v.cli === 'codex' || v.cli === 'assistant' || v.cli === 'banana')
      && typeof v.repoPath === 'string'
    ) {
      return {
        cli: v.cli,
        repoPath: v.repoPath,
        chatId: typeof v.chatId === 'string' ? v.chatId : 'main',
        sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
      };
    }
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
  banana: 'Banana',
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
  const toggleRepoStar = reposState.toggleStar;

  const [chronicleTick, setChronicleTick] = useState(0);
  const chronicle = useChronicle(chronicleTick);
  const commands = useCommands();
  const { sessions: liveSessions, removeLocal: removeLiveSession, refetch: refetchLive } = useLive();

  const dismissLiveSession = async (s: { cli: string; cwd: string; chatId?: string | null }) => {
    // Optimistic remove first so the row disappears instantly, then POST.
    // Refetch only after the POST resolves — refetching before would race
    // the server (still showing the session) and undo the optimistic remove.
    removeLiveSession(s.cli, s.cwd, s.chatId || 'main');
    try {
      await fetch('/api/session/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli: s.cli, cwd: s.cwd, chatId: s.chatId || 'main' }),
      });
    } catch {
      // Network blip — let the next regular poll reconcile.
    } finally {
      refetchLive();
    }
  };

  // Restore the last active conversation if there was one. We start in the
  // threshold view; once /api/repos resolves we bind the saved repoPath to
  // the matching Repo object and switch to conversation.
  const initialActive = readActive();
  const [view, setView] = useState<View>(initialActive ? 'conversation' : 'threshold');
  const [companion, setCompanion] = useState<CompanionId>(initialActive?.cli ?? 'claude');
  const [repo, setRepo] = useState<Repo | undefined>(undefined);
  const restorePathRef = useRef<string | null>(initialActive?.repoPath ?? null);
  /** A set-forth that hit the placeholder hub before /api/repos resolved.
   *  Held here and opened the moment the live hub arrives, so a conversation
   *  never starts on a half-known repo (wrong title, wrong model, and a
   *  session key the server never uses). */
  const saddlingRef = useRef<{
    companion: CompanionId;
    repo?: Repo;
    initialMessage?: string;
    chatId: string;
  } | null>(null);
  const [saddling, setSaddling] = useState(false);
  const [chronicleOpen, setChronicleOpen] = useState(false);
  const [chronicleCollapsed, setChronicleCollapsed] = useState(readChronicleCollapsed);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string>(initialActive?.chatId ?? 'main');
  const [errandTitle, setErrandTitle] = useState('a fresh errand');
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null);
  // Chosen Banana model. Defaults to the last pick (initial default
  // monkey/silverback). Only the Banana runner sends it.
  const [bananaModel, setBananaModel] = useState<string>(readStoredBananaModel);
  const [codexModel, setCodexModel] = useState<string>(readStoredCodexModel);
  const [codexEffort, setCodexEffort] = useState<string>(
    () => readStoredCodexEffort(codexModel),
  );
  /** True once the picker is touched in this view. A late first `ready` must
   *  never adopt over a pick the user just made. */
  const userPickedRef = useRef(false);
  /** Per-chat picks are stored under the lane that owns the picker. The
   *  assistant lane shows the Claude picker, so it shares Claude's memory. */
  const pickLane = (c: CompanionId): string => (c === 'assistant' ? 'claude' : c);
  const changeCodexModel = (value: string) => {
    userPickedRef.current = true;
    const model = normalizeCodexModel(value);
    const effort = normalizeCodexEffort(model, codexEffort);
    setCodexModel(model);
    setCodexEffort(effort);
    writeStoredCodexSelection(model, effort);
    writeChatPick(pickLane(companion), repo?.path, chatId, model, effort);
  };
  const changeCodexEffort = (value: string) => {
    userPickedRef.current = true;
    const effort = normalizeCodexEffort(codexModel, value);
    setCodexEffort(effort);
    writeStoredCodexSelection(codexModel, effort);
    writeChatPick(pickLane(companion), repo?.path, chatId, codexModel, effort);
  };
  const [claudeModel, setClaudeModel] = useState<string>(readStoredClaudeModel);
  const [claudeEffort, setClaudeEffort] = useState<string>(
    () => readStoredClaudeEffort(claudeModel),
  );
  const changeClaudeModel = (value: string) => {
    userPickedRef.current = true;
    const model = normalizeClaudeModel(value);
    const effort = normalizeClaudeEffort(model, claudeEffort);
    setClaudeModel(model);
    setClaudeEffort(effort);
    writeStoredClaudeSelection(model, effort);
    writeChatPick(pickLane(companion), repo?.path, chatId, model, effort);
  };
  const changeClaudeEffort = (value: string) => {
    userPickedRef.current = true;
    const effort = normalizeClaudeEffort(claudeModel, value);
    setClaudeEffort(effort);
    writeStoredClaudeSelection(claudeModel, effort);
    writeChatPick(pickLane(companion), repo?.path, chatId, claudeModel, effort);
  };
  const [assistantEngine, setAssistantEngineState] = useState<AssistantEngine>(readAssistantEngine);
  const setAssistantEngine = (e: AssistantEngine) => {
    setAssistantEngineState(e);
    if (typeof window !== 'undefined') localStorage.setItem(ASSISTANT_ENGINE_KEY, e);
  };

  const chat = useChat({
    repo,
    cli: companion,
    chatId,
    enabled: view === 'conversation' && !!repo,
    initialMessage: pendingFirstMessage,
    onInitialMessageSent: () => setPendingFirstMessage(null),
    model: companion === 'codex' ? codexModel
      : companion === 'banana' ? bananaModel
      // The assistant lane runs the Claude CLI, so it carries the Claude pair.
      : companion === 'claude' || companion === 'assistant' ? claudeModel
      : undefined,
    effort: companion === 'codex' ? codexEffort
      : companion === 'claude' || companion === 'assistant' ? claudeEffort
      : undefined,
    // A warm Claude session already runs at a fixed model + effort. Adopt it
    // so a browser that never made the pick (the phone) shows the truth, but
    // never over a pick made explicitly on this device. Returns true when it
    // adopted, which tells useChat the pending first message must go out at
    // the session's model instead of a stale stored default (that recycle
    // would otherwise drag the session back to the default).
    onSessionSelection: (sessionModel, sessionEffort) => {
      if (companion === 'codex') {
        const nextModel = normalizeCodexModel(sessionModel);
        const nextEffort = normalizeCodexEffort(nextModel, sessionEffort);
        // A pick made in this view, or one remembered for this chat, outranks
        // anything the session reports: the next send carries it.
        if (userPickedRef.current || readChatPick('codex', repo?.path, chatId)) return null;
        setCodexModel(nextModel);
        setCodexEffort(nextEffort);
        writeStoredCodexSelection(nextModel, nextEffort);
        return { model: nextModel, effort: nextEffort };
      }
      if (companion !== 'claude' && companion !== 'assistant') return null;
      const nextModel = normalizeClaudeModel(sessionModel);
      const nextEffort = normalizeClaudeEffort(nextModel, sessionEffort);
      const mirror = readSessionClaudeSelection();
      const storedModel = readStoredClaudeModel();
      const storedEffort = readStoredClaudeEffort(storedModel);
      // A pick made in THIS view outranks anything the session reports: the
      // next send recycles the session to it. A late first `ready` racing a
      // fast pick used to overwrite the picker (and the compact that followed
      // went out at the old model).
      if (userPickedRef.current) {
        if (nextModel === storedModel && nextEffort === storedEffort) {
          writeSessionClaudeSelection(nextModel, nextEffort);
        }
        return null;
      }
      // This chat has a pick of its own (made here, possibly never sent yet).
      // Keep showing it; the next send recycles the session onto it.
      if (readChatPick('claude', repo?.path, chatId)) return null;
      const explicitPick = !!mirror.model
        && (mirror.model !== storedModel || mirror.effort !== storedEffort);
      if (explicitPick) {
        // This browser holds an explicit pick (model or effort). If the
        // session has caught up to it, resume tracking the session so later
        // cross-device changes still follow; otherwise leave the pick alone.
        if (nextModel === storedModel && nextEffort === storedEffort) {
          writeSessionClaudeSelection(nextModel, nextEffort);
        }
        return null;
      }
      setClaudeModel(nextModel);
      setClaudeEffort(nextEffort);
      writeStoredClaudeSelection(nextModel, nextEffort);
      writeSessionClaudeSelection(nextModel, nextEffort);
      return { model: nextModel, effort: nextEffort };
    },
  });

  // Restore the picker to this chat's own pick the moment the chat changes.
  // The global keys are the fallback for a chat that has never had one, so a
  // change made on another device (or in another chat) does not leak in.
  useEffect(() => {
    userPickedRef.current = false;
    if (!repo?.path) return;
    const pick = readChatPick(pickLane(companion), repo.path, chatId);
    if (!pick) {
      // No pick of its own: fall back to the global last pick. Leaving the
      // previous chat's model on screen would be a lie about this chat.
      if (companion === 'codex') {
        const model = readStoredCodexModel();
        setCodexModel(model);
        setCodexEffort(readStoredCodexEffort(model));
      } else if (companion === 'claude' || companion === 'assistant') {
        const model = readStoredClaudeModel();
        setClaudeModel(model);
        setClaudeEffort(readStoredClaudeEffort(model));
      }
      return;
    }
    userPickedRef.current = true;
    if (companion === 'codex') {
      const model = normalizeCodexModel(pick.model);
      setCodexModel(model);
      setCodexEffort(normalizeCodexEffort(model, pick.effort));
    } else if (companion === 'claude' || companion === 'assistant') {
      const model = normalizeClaudeModel(pick.model);
      setClaudeModel(model);
      setClaudeEffort(normalizeClaudeEffort(model, pick.effort));
    }
  }, [companion, repo?.path, chatId]);

  // Once repos load, bind the restore-target path to a real Repo object.
  useEffect(() => {
    if (!restorePathRef.current || repo) return;
    const target = repos.find((r) => r.path === restorePathRef.current);
    if (target) {
      setRepo(target);
      restorePathRef.current = null;
    } else if (reposState.status === 'ready') {
      // Only a SUCCESSFUL list can prove the repo is gone. A transient fetch
      // failure must not throw away the saved conversation.
      restorePathRef.current = null;
      writeActive(null);
      setView('threshold');
    }
  }, [repos, reposState.status, repo]);

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
      // The ribbon's tending/idle chip is polled every 4s. A finished turn
      // must not keep reading "tending" next to the reply that just landed.
      refetchLive();
    }
    prevStatusRef.current = chat.status;
  }, [chat.status, liveBranch, refetchLive]);

  // Derive a title from the user's first message in the chat.
  useEffect(() => {
    const firstUser = chat.blocks.find((b) => b.kind === 'user');
    if (firstUser && firstUser.kind === 'user') {
      // Cut on a word, not mid-word: a title that ends "…colour is teal. Re"
      // looks broken in the header.
      const oneLine = firstUser.text.trim().split('\n')[0].replace(/\s+/g, ' ');
      const t = (() => {
        if (oneLine.length <= 46) return oneLine;
        const head = oneLine.slice(0, 46);
        const at = head.lastIndexOf(' ');
        const kept = (at > 12 ? head.slice(0, at) : head).replace(/[\s,;:.!?]+$/, '');
        return `${kept}…`;
      })();
      if (t) setErrandTitle(t);
    } else if (view === 'conversation' && chat.blocks.length === 0) {
      setErrandTitle('a fresh errand');
    }
  }, [chat.blocks, view]);

  const openConversation = useCallback(
    ({
      companion: c,
      repo: r,
      initialMessage,
      chatId: nextChatId,
    }: {
      companion: CompanionId;
      repo?: Repo;
      initialMessage?: string;
      chatId?: string | null;
    }) => {
      const normalizedChatId = nextChatId || 'main';
      restorePathRef.current = null;
      setCompanion(c);
      setRepo(r);
      setChatId(normalizedChatId);
      setView('conversation');
      setErrandTitle('a fresh errand');
      setPendingFirstMessage(initialMessage ?? null);
      if (r) writeActive({ cli: c, repoPath: r.path, chatId: normalizedChatId });
      else writeActive(null);
    },
    [],
  );

  const setForth = (params: {
    companion: CompanionId;
    repo?: Repo;
    initialMessage?: string;
    chatId?: string | null;
  }) => {
    const { companion: c, repo: r, initialMessage, chatId: nextChatId } = params;
    // Before /api/repos resolves the threshold can only offer the placeholder
    // hub, whose path belongs to a different machine. Opening a conversation
    // on it shows an empty page under the wrong title and model, and makes the
    // client expect a session key the server never uses (every stream event
    // gets dropped). Hold the whole request instead; the effect below opens it
    // the moment the real hub lands.
    if (r && r.path === ASSISTANT_HUB.path && !repos.some((known) => known.isAssistantHub)) {
      saddlingRef.current = {
        companion: c,
        repo: undefined,
        initialMessage,
        chatId: nextChatId || 'main',
      };
      setSaddling(true);
      return;
    }
    openConversation({ companion: c, repo: r, initialMessage, chatId: nextChatId });
  };

  // Release a held set-forth once the repo list settles. A live hub is the
  // happy path; if the server never announces one, open the request as-is so
  // the typed prompt is never stranded on the threshold.
  const liveHubRepo = repos.find((known) => known.isAssistantHub);
  useEffect(() => {
    const held = saddlingRef.current;
    if (!held) return;
    if (liveHubRepo) {
      saddlingRef.current = null;
      setSaddling(false);
      // The engine picked on the threshold is carried through the hold: the
      // Assistant lane runs whichever engine is selected, and by now the hub
      // is real, so a Codex/Banana pick is safe to apply.
      const c = held.companion === 'assistant' && assistantEngine !== 'claude'
        ? assistantEngine
        : held.companion;
      openConversation({ ...held, companion: c, repo: liveHubRepo });
    } else if (reposState.status === 'ready') {
      // A successful list with no hub announced. Open the request with a real
      // repo: a thread with no repo cannot send at all, so opening one would
      // strand the typed prompt worse than staying on the threshold. A failed
      // fetch keeps the hold.
      saddlingRef.current = null;
      setSaddling(false);
      const fallback = held.repo ?? repos.find((known) => !known.isAssistantHub);
      if (fallback) openConversation({ ...held, repo: fallback });
    }
  }, [liveHubRepo, reposState.status, repos, openConversation, assistantEngine]);

  const repoForPath = (path: string, name?: string): Repo => {
    const known = repos.find((r) => r.path === path);
    return known ? { ...known } : { path, name: name || basenameOfPath(path), hub: 'Live' };
  };

  const openLiveSession = (s: {
    cli: CompanionId;
    cwd: string;
    repoName: string;
    chatId?: string | null;
    sessionId: string | null;
  }) => {
    // If this live session corresponds to a chronicle entry, keep both the
    // live indicator and the chronicle row highlighted in sync.
    setActiveEventId(s.sessionId ?? null);
    setForth({
      companion: s.cli,
      repo: repoForPath(s.cwd, s.repoName),
      chatId: s.chatId || 'main',
    });
  };

  const openChronicleEvent = async (id: string) => {
    const ev = chronicle.events.find((e) => e.id === id);
    if (!ev) return;
    setActiveEventId(id);
    // Drop any pending threshold-entered prompt — it belongs to whatever
    // conversation the user typed it in, not this chronicle session.
    setPendingFirstMessage(null);

    if (!ev.cwd) {
      setView('conversation');
      return;
    }

    const c: CompanionId = ev.cwd === ASSISTANT_HUB.path ? 'assistant' : 'claude';
    try {
      const r = await fetch('/api/session/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli: c, cwd: ev.cwd, sessionId: ev.id, chatId: ev.id }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.warn('failed to activate chronicle session', e);
    }

    const activatedRepo = repoForPath(ev.cwd, ev.repo);
    setCompanion(c);
    setRepo(activatedRepo);
    setChatId(ev.id);
    setView('conversation');
    writeActive({ cli: c, repoPath: ev.cwd, chatId: ev.id, sessionId: ev.id });
    setErrandTitle(ev.title || 'a fresh errand');
  };

  const beginFreshThread = () => {
    chat.freshStart();
    setActiveEventId(null);
    setErrandTitle('a fresh errand');
    if (repo) writeActive({ cli: companion, repoPath: repo.path, chatId });
  };

  const goToThreshold = () => {
    setView('threshold');
    writeActive(null);
  };

  // Returning to the threshold should land on the agent, engine and repo the
  // conversation was actually using, not the threshold's own defaults — typing
  // straight away must never quietly switch to a different agent or repo.
  const assistantHubPath = repos.find((r) => r.isAssistantHub)?.path ?? ASSISTANT_HUB.path;
  const onAssistantHub = !!repo && (repo.isAssistantHub || repo.path === assistantHubPath);
  const thresholdCompanion: CompanionId = onAssistantHub ? 'assistant' : companion;

  const branchForLabel = liveBranch.branch ?? repo?.branch;
  const repoLabel = repo
    ? `${repo.name}${branchForLabel ? ` · ${branchForLabel}` : ''}`
    : 'just chatting';
  const commandPrefix = companion === 'codex' ? '$' : '/';
  // /compact is a CLI built-in, not a file in ~/.claude/commands, so it is
  // added here for the Claude lanes. Typing it sends the compact action
  // instead of a chat message.
  const claudeCommands = commands.claude.some((c) => c.name === 'compact')
    ? commands.claude
    : [
        { name: 'compact', title: 'Compact', description: 'summarize this chat and make room' },
        ...commands.claude,
      ];
  const activeCommands =
    companion === 'codex' ? commands.codex
    : companion === 'banana' ? commands.banana
    : claudeCommands;

  const appClass = `sw-app sw-paper${theme === 'dark' ? ' sw-dark' : ''}`;

  // Restoring a saved conversation before /api/repos resolves: the repo (and
  // so the title, model and session key) is not known yet. Show an honest
  // "making ready" instead of an empty conversation under a wrong heading.
  const awaitingRestore = view === 'conversation' && !repo && restorePathRef.current !== null;

  useEffect(() => {
    localStorage.setItem(CHRONICLE_COLLAPSED_KEY, chronicleCollapsed ? '1' : '0');
  }, [chronicleCollapsed]);

  // Model-picker wiring for the active companion. Claude, Codex and the
  // assistant lane (which runs the Claude CLI) expose a model + reasoning-
  // effort pair; Banana a model only.
  const activeModelPicker: 'banana' | 'codex' | 'claude' | undefined =
    companion === 'banana' ? 'banana'
    : companion === 'codex' ? 'codex'
    : companion === 'claude' || companion === 'assistant' ? 'claude'
    : undefined;
  const pickerModel =
    companion === 'codex' ? codexModel
    : companion === 'claude' || companion === 'assistant' ? claudeModel
    : bananaModel;
  const pickerEffort =
    companion === 'codex' ? codexEffort
    : companion === 'claude' || companion === 'assistant' ? claudeEffort
    : undefined;
  const onPickerModelChange =
    companion === 'codex' ? changeCodexModel
    : companion === 'claude' || companion === 'assistant' ? changeClaudeModel
    : setBananaModel;
  const onPickerEffortChange =
    companion === 'codex' ? changeCodexEffort
    : companion === 'claude' || companion === 'assistant' ? changeClaudeEffort
    : undefined;

  if (isMobile) {
    return (
      <div className={appClass}>
        {view === 'threshold' ? (
          <MobileThreshold
            repos={repos}
            reposLoading={reposLoading}
            onSetForth={setForth}
            onToggleStar={toggleRepoStar}
            liveSessions={liveSessions}
            onSelectLive={(s) => {
              openLiveSession(s);
            }}
            onDismissLive={dismissLiveSession}
            theme={theme}
            onToggleTheme={toggleTheme}
            assistantEngine={assistantEngine}
            onAssistantEngineChange={setAssistantEngine}
            initialCompanion={thresholdCompanion}
            initialRepo={repo}
            settingForth={saddling}
            reposError={reposState.status === 'error'}
            onRetryRepos={() => reposState.reload()}
          />
        ) : awaitingRestore ? (
          <MakingReady error={reposState.status === 'error'} onRetry={() => reposState.reload()} />
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
            onFreshStart={beginFreshThread}
            onStop={chat.stop}
            onAnswerTool={chat.respondToTool}
            onTogglePlanMode={chat.setPlanMode}
            planMode={chat.planMode}
            acceptImages={true}
            modelPicker={activeModelPicker}
            model={pickerModel}
            effort={pickerEffort}
            onModelChange={onPickerModelChange}
            onEffortChange={onPickerEffortChange}
            onCompact={companion === 'claude' || companion === 'assistant' || companion === 'codex' ? chat.compact : undefined}
            compactBusy={chat.compacting}
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

  const activeLiveKey =
    view === 'conversation' && repo ? `${companion}|${repo.path}|${chatId}` : null;

  return (
    <div className={appClass} style={{ flexDirection: 'row' }}>
      <ChronicleRibbon
        events={chronicle.events}
        activeId={view === 'conversation' ? activeEventId : null}
        activeLiveKey={activeLiveKey}
        collapsed={chronicleCollapsed}
        onToggleCollapsed={() => setChronicleCollapsed((v) => !v)}
        liveSessions={liveSessions}
        onSelectLive={(s) => {
          openLiveSession(s);
        }}
        onDismissLive={dismissLiveSession}
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
            onToggleStar={toggleRepoStar}
            assistantEngine={assistantEngine}
            onAssistantEngineChange={setAssistantEngine}
            initialCompanion={thresholdCompanion}
            initialRepo={repo}
            settingForth={saddling}
            reposError={reposState.status === 'error'}
            onRetryRepos={() => reposState.reload()}
          />
        ) : awaitingRestore ? (
          <MakingReady error={reposState.status === 'error'} onRetry={() => reposState.reload()} />
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
            onFreshStart={beginFreshThread}
            onStop={chat.stop}
            onAnswerTool={chat.respondToTool}
            onTogglePlanMode={chat.setPlanMode}
            planMode={chat.planMode}
            acceptImages={true}
            modelPicker={activeModelPicker}
            model={pickerModel}
            effort={pickerEffort}
            onModelChange={onPickerModelChange}
            onEffortChange={onPickerEffortChange}
            onCompact={companion === 'claude' || companion === 'assistant' || companion === 'codex' ? chat.compact : undefined}
            compactBusy={chat.compacting}
          />
        )}
      </main>
    </div>
  );
}
