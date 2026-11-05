import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCost } from '../../src/core/cost.js';
import type {
  DoctorReportPayload,
  InitPayload,
  ModelHandle,
  PermissionModeName,
  PermissionRequestPayload,
  SessionInfo,
  SessionPayload,
  TokenTotals,
} from '../../src/desktop/api.js';
import { collectChanges } from './changes';
import { ApprovalCard } from './components/ApprovalCard';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { Composer } from './components/Composer';
import { Icon } from './components/Icons';
import { Inspector, type InspectorTab } from './components/Inspector';
import { SessionHeader } from './components/SessionHeader';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import type { WireAgentEvent } from './events';
import { applyTheme, loadPrefs, savePrefs, type UiPrefs } from './prefs';
import { attachToolResult, type Entry, entriesFromMessages } from './transcript';

const MODE_NAMES: PermissionModeName[] = ['plan', 'default', 'acceptEdits', 'yolo'];

const HELP_TEXT = [
  'Commands',
  '/new  start a new session        /clear  clear into a fresh session',
  '/cost  session tokens and cost   /model  switch provider and model',
  '/mode [plan|default|acceptEdits|yolo]   /files  browse workspace files',
  '/mcp  MCP servers and diagnostics   /doctor  run checks   /help  this list',
  '',
  'Shortcuts',
  'Ctrl K  command palette   Ctrl N  new session',
  'Ctrl B  sessions          Ctrl J  inspector',
  '@  mention a file         /  commands      Enter  send',
].join('\n');

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Welcome({
  version,
  busy,
  onOpen,
}: {
  version: string;
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <main className="welcome">
      <div className="welcome-inner">
        <p className="welcome-eyebrow mono">desktop coding agent · v{version}</p>
        <h1 className="welcome-brand">
          <span className="brand-mark">cake</span>
        </h1>
        <p className="welcome-lede">
          A small, sharp coding agent for your own machine. Open a folder, describe the change, and
          approve the moments that matter.
        </p>
        <div className="welcome-actions">
          <button type="button" className="primary big" onClick={onOpen} disabled={busy}>
            <Icon name="folder" size={16} />
            Open folder…
          </button>
          <span className="welcome-hint mono">sessions stay local</span>
        </div>
        <div className="welcome-grid">
          <article className="welcome-card">
            <span className="welcome-card-icon">
              <Icon name="spark" size={16} />
            </span>
            <h2>Agent loop</h2>
            <p>
              Reads, searches, edits, and runs commands across multiple steps until the task is
              done.
            </p>
          </article>
          <article className="welcome-card">
            <span className="welcome-card-icon">
              <Icon name="check" size={16} />
            </span>
            <h2>Approvals</h2>
            <p>Plan, default, accept edits, or YOLO. Writes and shell calls pause for your call.</p>
          </article>
          <article className="welcome-card">
            <span className="welcome-card-icon">
              <Icon name="panel" size={16} />
            </span>
            <h2>Context</h2>
            <p>Project instructions, a codebase index, MCP tools, and a visible context budget.</p>
          </article>
        </div>
      </div>
    </main>
  );
}

export function App() {
  const [init, setInit] = useState<InitPayload | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState('');
  const [approvals, setApprovals] = useState<PermissionRequestPayload[]>([]);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<TokenTotals | null>(null);
  const [doctor, setDoctor] = useState<DoctorReportPayload | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('changes');
  const [focusToken, setFocusToken] = useState(0);
  const [modelMenuSignal, setModelMenuSignal] = useState(0);
  const [modeMenuSignal, setModeMenuSignal] = useState(0);
  const [prefs, setPrefs] = useState<UiPrefs>(() => {
    const loaded = loadPrefs();
    if (typeof window !== 'undefined' && window.innerWidth < 860) {
      return { ...loaded, railOpen: false, inspectorOpen: false };
    }
    return loaded;
  });

  const nextId = useRef(0);
  const streamRef = useRef('');
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runningRef = useRef(false);

  const addEntry = useCallback((entry: Omit<Entry, 'id'>) => {
    const id = nextId.current++;
    setEntries((list) => [...list, { ...entry, id }]);
  }, []);

  /** Streaming text lives in a ref and is flushed to React state at most every 50ms. */
  const takeStream = useCallback((): string => {
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const text = streamRef.current;
    streamRef.current = '';
    setStreaming('');
    return text;
  }, []);

  const handleEvent = useCallback(
    (raw: unknown) => {
      const event = raw as WireAgentEvent;
      switch (event.type) {
        case 'text-delta': {
          streamRef.current += event.delta;
          if (flushTimer.current === null) {
            flushTimer.current = setTimeout(() => {
              flushTimer.current = null;
              setStreaming(streamRef.current);
            }, 50);
          }
          break;
        }
        case 'tool-call': {
          const text = takeStream();
          if (text.trim()) addEntry({ role: 'assistant', text });
          addEntry({
            role: 'tool',
            tool: { name: event.toolName, input: event.input, status: 'running' },
          });
          break;
        }
        case 'tool-result':
          setEntries((list) => attachToolResult(list, event.toolName, event.output, 'done'));
          break;
        case 'tool-error':
          setEntries((list) =>
            attachToolResult(list, event.toolName, event.error.message, 'error'),
          );
          break;
        case 'subagent-start':
          addEntry({ role: 'info', text: `subagent ${event.agentType}: ${event.prompt}` });
          break;
        case 'subagent-end':
          addEntry({
            role: 'info',
            text: `subagent ${event.agentType} finished · ${event.usage.totalTokens} tokens`,
          });
          break;
        case 'finish': {
          const text = takeStream();
          setLastUsage(event.usage);
          const meta = `${event.usage.totalTokens} tokens · ${formatCost(event.costUsd)}`;
          if (text.trim()) addEntry({ role: 'assistant', text, meta });
          else if (event.usage.totalTokens > 0) addEntry({ role: 'info', text: meta });
          break;
        }
        case 'error':
          takeStream();
          addEntry({ role: 'error', text: `${event.error.name}: ${event.error.message}` });
          break;
        default:
          break;
      }
    },
    [addEntry, takeStream],
  );

  const refreshSessions = useCallback(async () => {
    const api = window.cake;
    if (!api) return;
    try {
      setSessions(await api.listSessions());
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const applySession = useCallback((payload: SessionPayload) => {
    const restored = entriesFromMessages(payload.messages);
    nextId.current = restored.length;
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    streamRef.current = '';
    setStreaming('');
    setEntries(restored);
    setApprovals([]);
    setLastUsage(null);
    setInit((current) =>
      current
        ? {
            ...current,
            workspace: { cwd: payload.session.cwd, sessionId: payload.session.id },
            model: { provider: payload.session.provider, modelId: payload.session.model },
          }
        : current,
    );
  }, []);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const api = window.cake;
      if (!api) return;
      applySession(await api.openSession(sessionId));
    },
    [applySession],
  );

  useEffect(() => {
    applyTheme(prefs.theme);
    savePrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    const api = window.cake;
    if (!api) {
      setError('cake bridge is not available (preload failed to load)');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const payload = await api.init();
        if (cancelled) return;
        setInit(payload);
        const list = await api.listSessions();
        if (cancelled) return;
        setSessions(list);
        if (payload.workspace) await loadSession(payload.workspace.sessionId);
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSession]);

  useEffect(() => {
    const api = window.cake;
    if (!api) return;
    const offs = [
      api.onAgentEvent(handleEvent),
      api.onAgentNote((note) => addEntry({ role: 'info', text: `${note.kind}: ${note.text}` })),
      api.onPermissionRequest((request) => setApprovals((list) => [...list, request])),
      api.onMcpStatus((status) =>
        setInit((current) => (current ? { ...current, mcpStatus: status } : current)),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [handleEvent, addEntry]);

  const newSession = useCallback(async () => {
    const api = window.cake;
    if (!api || runningRef.current || !init?.workspace) return;
    setBusy(true);
    try {
      applySession(await api.newSession());
      await refreshSessions();
      setError(null);
      setFocusToken((value) => value + 1);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }, [init?.workspace, applySession, refreshSessions]);

  const openSession = useCallback(
    async (id: string) => {
      if (runningRef.current) return;
      setBusy(true);
      try {
        await loadSession(id);
        setError(null);
        setFocusToken((value) => value + 1);
      } catch (err) {
        setError(message(err));
      } finally {
        setBusy(false);
      }
    },
    [loadSession],
  );

  const renameSession = useCallback(async (id: string, title: string) => {
    const api = window.cake;
    if (!api) return;
    try {
      setSessions(await api.renameSession(id, title));
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      const api = window.cake;
      if (!api || runningRef.current) return;
      setBusy(true);
      try {
        const payload = await api.deleteSession(id);
        if (payload) applySession(payload);
        await refreshSessions();
        setError(null);
      } catch (err) {
        setError(message(err));
      } finally {
        setBusy(false);
      }
    },
    [applySession, refreshSessions],
  );

  const openWorkspace = useCallback(async () => {
    const api = window.cake;
    if (!api || runningRef.current) return;
    setBusy(true);
    try {
      const picked = await api.pickWorkspace();
      if (!picked) return;
      const payload = await api.openWorkspace(picked);
      setInit(payload);
      nextId.current = 0;
      setEntries([]);
      setStreaming('');
      setApprovals([]);
      setLastUsage(null);
      setDoctor(null);
      if (payload.workspace) await loadSession(payload.workspace.sessionId);
      await refreshSessions();
      setError(null);
      setFocusToken((value) => value + 1);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }, [loadSession, refreshSessions]);

  const changeModel = useCallback(
    async (model: ModelHandle) => {
      const api = window.cake;
      if (!api) return;
      setBusy(true);
      try {
        setInit(await api.setModel(model));
        await refreshSessions();
        setError(null);
      } catch (err) {
        setError(message(err));
      } finally {
        setBusy(false);
      }
    },
    [refreshSessions],
  );

  const changeMode = useCallback(async (mode: PermissionModeName) => {
    const api = window.cake;
    if (!api) return;
    try {
      setInit(await api.setMode(mode));
      setError(null);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const reloadMcp = useCallback(async () => {
    const api = window.cake;
    if (!api) return;
    setBusy(true);
    try {
      setInit(await api.reloadMcp());
      setError(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const runDoctorChecks = useCallback(async () => {
    const api = window.cake;
    if (!api) return;
    setDoctorBusy(true);
    try {
      setDoctor(await api.runDoctor());
    } catch (err) {
      setError(message(err));
    } finally {
      setDoctorBusy(false);
    }
  }, []);

  const openInspector = useCallback((tab?: InspectorTab) => {
    setPrefs((current) => ({
      ...current,
      inspectorOpen: true,
      railOpen: window.innerWidth < 860 ? false : current.railOpen,
    }));
    if (tab) setInspectorTab(tab);
  }, []);

  const insertFile = useCallback((file: string) => {
    setPrompt((current) => {
      const trimmed = current.replace(/\s+$/, '');
      return trimmed ? `${trimmed} @${file} ` : `@${file} `;
    });
    setFocusToken((value) => value + 1);
  }, []);

  const loadFiles = useCallback(async (query: string) => {
    const api = window.cake;
    if (!api) return [];
    try {
      return await api.listFiles(query);
    } catch {
      return [];
    }
  }, []);

  const showCost = useCallback(() => {
    const current = sessions.find((session) => session.id === init?.workspace?.sessionId);
    addEntry({
      role: 'info',
      text: `session ${current?.totalTokens ?? 0} tokens · ${formatCost(current?.costUsd ?? 0)}`,
    });
  }, [addEntry, init?.workspace?.sessionId, sessions]);

  const runSlash = useCallback(
    (raw: string): boolean => {
      if (!raw.startsWith('/')) return false;
      const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
      if (!match) {
        addEntry({ role: 'error', text: `unknown command "${raw}" — type /help` });
        return true;
      }
      const name = (match[1] ?? '').toLowerCase();
      const arg = (match[2] ?? '').trim();
      switch (name) {
        case 'new':
        case 'clear':
          void newSession();
          return true;
        case 'cost':
          showCost();
          return true;
        case 'model':
          setModelMenuSignal((value) => value + 1);
          return true;
        case 'mode': {
          if (!arg) {
            setModeMenuSignal((value) => value + 1);
            return true;
          }
          const picked = MODE_NAMES.find((mode) => mode.toLowerCase() === arg.toLowerCase());
          if (picked) {
            void changeMode(picked);
          } else {
            addEntry({
              role: 'error',
              text: `unknown mode "${arg}" — plan, default, acceptEdits, or yolo`,
            });
          }
          return true;
        }
        case 'files':
          openInspector('files');
          return true;
        case 'mcp':
          openInspector('context');
          return true;
        case 'doctor':
          openInspector('context');
          void runDoctorChecks();
          return true;
        case 'help':
          addEntry({ role: 'info', text: HELP_TEXT });
          return true;
        default:
          addEntry({ role: 'error', text: `unknown command /${name} — type /help` });
          return true;
      }
    },
    [addEntry, changeMode, newSession, openInspector, runDoctorChecks, showCost],
  );

  const submit = useCallback(async () => {
    const raw = prompt.trim();
    const sessionId = init?.workspace?.sessionId;
    if (!raw || !sessionId || runningRef.current || busy) return;
    setPrompt('');
    setError(null);
    if (runSlash(raw)) {
      setFocusToken((value) => value + 1);
      return;
    }
    setApprovals([]);
    addEntry({ role: 'user', text: raw });
    runningRef.current = true;
    setRunning(true);
    try {
      await window.cake?.run(sessionId, raw);
    } catch (err) {
      addEntry({ role: 'error', text: message(err) });
    } finally {
      runningRef.current = false;
      setRunning(false);
      setApprovals([]);
      const leftover = takeStream();
      if (leftover.trim()) addEntry({ role: 'assistant', text: leftover });
      await refreshSessions();
      setFocusToken((value) => value + 1);
    }
  }, [prompt, init?.workspace?.sessionId, busy, runSlash, addEntry, takeStream, refreshSessions]);

  const stop = useCallback(() => {
    void window.cake?.abort();
  }, []);

  const respond = useCallback(async (id: string, decision: 'allow' | 'deny') => {
    setApprovals((list) => list.filter((item) => item.id !== id));
    try {
      await window.cake?.respondPermission(id, decision);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  const toggleRail = useCallback(() => {
    setPrefs((current) => {
      const railOpen = !current.railOpen;
      return {
        ...current,
        railOpen,
        inspectorOpen: railOpen && window.innerWidth < 860 ? false : current.inspectorOpen,
      };
    });
  }, []);

  const toggleInspector = useCallback(() => {
    setPrefs((current) => {
      const inspectorOpen = !current.inspectorOpen;
      return {
        ...current,
        inspectorOpen,
        railOpen: inspectorOpen && window.innerWidth < 860 ? false : current.railOpen,
      };
    });
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 860) return;
      setPrefs((current) =>
        current.railOpen || current.inspectorOpen
          ? { ...current, railOpen: false, inspectorOpen: false }
          : current,
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleTheme = useCallback(() => {
    setPrefs((current) => ({
      ...current,
      theme: current.theme === 'night' ? 'parchment' : 'night',
    }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      } else if (key === 'n') {
        event.preventDefault();
        void newSession();
      } else if (key === 'b') {
        event.preventDefault();
        toggleRail();
      } else if (key === 'j') {
        event.preventDefault();
        toggleInspector();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, newSession, toggleRail, toggleInspector]);

  const changes = useMemo(() => collectChanges(entries), [entries]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const hasWorkspace = Boolean(init?.workspace);
    const actions: PaletteAction[] = [
      {
        id: 'new-session',
        label: 'New session',
        group: 'Session',
        hint: 'Ctrl N',
        disabled: !hasWorkspace || running,
        run: () => void newSession(),
      },
      {
        id: 'model',
        label: 'Switch model…',
        group: 'Session',
        disabled: !hasWorkspace,
        run: () => setModelMenuSignal((value) => value + 1),
      },
      {
        id: 'mode',
        label: 'Switch permission mode…',
        group: 'Session',
        disabled: !hasWorkspace,
        run: () => setModeMenuSignal((value) => value + 1),
      },
      {
        id: 'cost',
        label: 'Show session cost',
        group: 'Session',
        disabled: !hasWorkspace,
        run: showCost,
      },
      {
        id: 'open-workspace',
        label: 'Open folder…',
        group: 'Workspace',
        disabled: running,
        run: () => void openWorkspace(),
      },
      {
        id: 'reload-mcp',
        label: 'Reload MCP servers',
        group: 'Workspace',
        disabled: !hasWorkspace || running,
        run: () => void reloadMcp(),
      },
      {
        id: 'doctor',
        label: 'Run diagnostics',
        group: 'Workspace',
        run: () => {
          openInspector('context');
          void runDoctorChecks();
        },
      },
      {
        id: 'toggle-rail',
        label: prefs.railOpen ? 'Hide sessions' : 'Show sessions',
        group: 'View',
        hint: 'Ctrl B',
        run: toggleRail,
      },
      {
        id: 'toggle-inspector',
        label: prefs.inspectorOpen ? 'Hide inspector' : 'Show inspector',
        group: 'View',
        hint: 'Ctrl J',
        run: toggleInspector,
      },
      {
        id: 'theme',
        label: `Switch to ${prefs.theme === 'night' ? 'parchment' : 'night'} theme`,
        group: 'View',
        run: toggleTheme,
      },
    ];

    for (const session of sessions) {
      actions.push({
        id: `session-${session.id}`,
        label: session.title || 'Untitled session',
        group: 'Sessions',
        hint: session.model,
        disabled: running || session.id === init?.workspace?.sessionId,
        run: () => void openSession(session.id),
      });
    }
    return actions;
  }, [
    init?.workspace,
    sessions,
    running,
    prefs.railOpen,
    prefs.inspectorOpen,
    prefs.theme,
    newSession,
    openSession,
    showCost,
    openWorkspace,
    reloadMcp,
    runDoctorChecks,
    openInspector,
    toggleRail,
    toggleInspector,
    toggleTheme,
  ]);

  if (!init) {
    return (
      <div className="loading">
        <span className="brand-mark">cake</span>
        <p className="hint">{error ? `Failed to start: ${error}` : 'Starting Cake…'}</p>
      </div>
    );
  }

  const workspace = init.workspace;
  const activeSession = sessions.find((session) => session.id === workspace?.sessionId) ?? null;
  const activeProvider = init.providers.find((provider) => provider.id === init.model.provider);
  const used = activeSession?.totalTokens ?? 0;

  return (
    <div
      className={`app${workspace && prefs.railOpen ? '' : ' rail-closed'}${
        workspace && prefs.inspectorOpen ? '' : ' inspector-closed'
      }`}
    >
      {workspace && prefs.railOpen ? (
        <Sidebar
          version={init.version}
          workspace={workspace}
          sessions={sessions}
          activeSessionId={workspace.sessionId}
          running={running}
          mcpStatus={init.mcpStatus}
          onNewSession={() => void newSession()}
          onOpenSession={(id) => void openSession(id)}
          onRenameSession={(id, title) => void renameSession(id, title)}
          onDeleteSession={(id) => void deleteSession(id)}
          onOpenWorkspace={() => void openWorkspace()}
          onDiagnostics={() => {
            openInspector('context');
            void runDoctorChecks();
          }}
          onClose={toggleRail}
        />
      ) : null}

      <div className="stage">
        {workspace ? (
          <>
            <SessionHeader
              session={activeSession}
              railOpen={prefs.railOpen}
              inspectorOpen={prefs.inspectorOpen}
              theme={prefs.theme}
              onToggleRail={toggleRail}
              onToggleInspector={toggleInspector}
              onToggleTheme={toggleTheme}
              onOpenPalette={() => setPaletteOpen(true)}
            />

            {error ? (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError(null)}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ) : null}

            {init.missingKeys.length > 0 ? (
              <div className="notice mono">
                <span className="notice-dot" />
                <span>
                  No API key for {init.missingKeys.join(', ')} — set{' '}
                  {init.missingKeys.map((id) => `${id.toUpperCase()}_API_KEY`).join(' / ')}.
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    openInspector('context');
                    void runDoctorChecks();
                  }}
                >
                  Diagnostics
                </button>
              </div>
            ) : null}

            {init.mcpStatus.warnings.map((warning) => (
              <div key={warning} className="notice is-warn mono">
                <span className="notice-dot" />
                <span>{warning}</span>
              </div>
            ))}

            <main className="conversation">
              <Transcript entries={entries} streaming={streaming} />

              {approvals.length > 0 ? (
                <div className="approvals" data-testid="approvals">
                  {approvals.map((request) => (
                    <ApprovalCard
                      key={request.id}
                      request={request}
                      pending={Math.max(approvals.length - 1, 0)}
                      onRespond={(id, decision) => void respond(id, decision)}
                    />
                  ))}
                </div>
              ) : null}

              <Composer
                value={prompt}
                running={running}
                disabled={busy}
                onChange={setPrompt}
                onSubmit={() => void submit()}
                onStop={stop}
                loadFiles={loadFiles}
                focusToken={focusToken}
                init={init}
                used={used}
                maxContext={activeProvider?.maxContext ?? 0}
                modelMenuSignal={modelMenuSignal}
                modeMenuSignal={modeMenuSignal}
                onSetModel={(model) => void changeModel(model)}
                onSetMode={(mode) => void changeMode(mode)}
              />
            </main>
          </>
        ) : (
          <>
            {error ? (
              <div className="error-banner welcome-error" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError(null)}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ) : null}
            <Welcome version={init.version} busy={busy} onOpen={() => void openWorkspace()} />
          </>
        )}
      </div>

      {workspace && prefs.inspectorOpen ? (
        <Inspector
          init={init}
          session={activeSession}
          used={used}
          lastUsage={lastUsage}
          changes={changes}
          tab={inspectorTab}
          doctor={doctor}
          doctorBusy={doctorBusy}
          onTab={setInspectorTab}
          onClose={toggleInspector}
          onRunDoctor={() => void runDoctorChecks()}
          onReloadMcp={() => void reloadMcp()}
          onInsertFile={insertFile}
        />
      ) : null}

      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
