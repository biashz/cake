import { useEffect, useMemo, useRef, useState } from 'react';
import { spendLabel } from '../../../src/core/cost.js';
import type { McpStatus, SessionInfo } from '../../../src/desktop/api.js';
import { Icon } from './Icons';

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function groupLabel(updatedAt: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(updatedAt)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return 'Earlier';
}

function relativeTime(updatedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || normalized;
}

export function Sidebar({
  version,
  workspace,
  recents,
  sessions,
  activeSessionId,
  running,
  pendingApprovals,
  mcpStatus,
  onNewSession,
  onOpenSession,
  onRenameSession,
  onForkSession,
  onExportSession,
  onDeleteSession,
  onOpenWorkspace,
  onOpenRecent,
  onDiagnostics,
  onClose,
}: {
  version: string;
  workspace: { cwd: string; sessionId: string } | null;
  recents: string[];
  sessions: SessionInfo[];
  activeSessionId: string | null;
  running: boolean;
  pendingApprovals: number;
  mcpStatus: McpStatus;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onForkSession: (id: string) => void;
  onExportSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onOpenWorkspace: () => void;
  onOpenRecent: (path: string) => void;
  onDiagnostics: () => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [recentsOpen, setRecentsOpen] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editingId) return;
    const node = renameRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [editingId]);

  useEffect(() => {
    if (!confirmId) return;
    const timer = setTimeout(() => setConfirmId(null), 3000);
    return () => clearTimeout(timer);
  }, [confirmId]);

  useEffect(() => {
    if (!recentsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!otherRef.current?.contains(event.target as Node)) setRecentsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRecentsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [recentsOpen]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) =>
      `${session.title} ${session.model} ${session.provider}`.toLowerCase().includes(needle),
    );
  }, [query, sessions]);

  const groups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const session of filtered) {
      const label = groupLabel(session.updatedAt);
      map.set(label, [...(map.get(label) ?? []), session]);
    }
    return [...map.entries()];
  }, [filtered]);

  const mcpFailing = mcpStatus.rows.filter((row) => row.error !== null).map((row) => row.name);

  const startRename = (session: SessionInfo) => {
    setEditingId(session.id);
    setDraft(session.title || '');
    setConfirmId(null);
  };

  const commitRename = (id: string) => {
    if (editingId !== id) return;
    const title = draft.trim();
    setEditingId(null);
    const current = sessions.find((session) => session.id === id);
    if (title !== (current?.title ?? '')) onRenameSession(id, title);
  };

  const requestDelete = (id: string) => {
    if (confirmId === id) {
      setConfirmId(null);
      onDeleteSession(id);
      return;
    }
    setConfirmId(id);
  };

  return (
    <aside className="rail" aria-label="Sessions">
      <div className="rail-brand">
        <div className="brand-lockup">
          <span className="brand-mark">cake</span>
          <span className="brand-version mono">v{version}</span>
        </div>
        {onClose ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Hide sessions"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        ) : null}
      </div>

      <div className="workspace-block" ref={otherRef}>
        <button
          type="button"
          className="workspace-switcher"
          onClick={onOpenWorkspace}
          title={workspace?.cwd ?? 'Choose a workspace folder'}
        >
          <Icon name="folder" size={15} />
          <span className="workspace-copy">
            <span className="workspace-name">
              {workspace ? basename(workspace.cwd) : 'No workspace'}
            </span>
            <span className="workspace-path mono">
              {workspace ? workspace.cwd : 'Open a folder to begin'}
            </span>
          </span>
        </button>
        {recents.length > 0 ? (
          <button
            type="button"
            className="workspace-recent-toggle"
            aria-expanded={recentsOpen}
            aria-haspopup="menu"
            onClick={() => setRecentsOpen((open) => !open)}
          >
            <Icon name="clock" size={13} />
            <span className="sr-only">Recent workspaces</span>
          </button>
        ) : null}
        {recentsOpen ? (
          <div className="workspace-menu" role="menu" aria-label="Recent workspaces">
            <p className="rail-label">Recent</p>
            {recents.map((path) => (
              <button
                key={path}
                type="button"
                role="menuitem"
                className={`workspace-menu-item${path === workspace?.cwd ? ' is-current' : ''}`}
                onClick={() => {
                  setRecentsOpen(false);
                  if (path !== workspace?.cwd) onOpenRecent(path);
                }}
              >
                <span className="workspace-menu-name">{basename(path)}</span>
                <span className="workspace-menu-path mono">{path}</span>
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className="workspace-menu-item"
              onClick={onOpenWorkspace}
            >
              <span className="workspace-menu-name">Open another folder…</span>
            </button>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="new-session primary"
        onClick={onNewSession}
        disabled={!workspace || running}
      >
        <Icon name="plus" size={15} />
        New session
        <span className="key-hint mono">Ctrl N</span>
      </button>

      <label className="rail-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          spellCheck={false}
          aria-label="Search sessions"
        />
      </label>

      <div className="session-list">
        {!workspace ? (
          <p className="rail-empty">Open a folder to see its sessions.</p>
        ) : groups.length === 0 ? (
          <p className="rail-empty">
            {query ? 'No session matches that search.' : 'No sessions yet. Start one above.'}
          </p>
        ) : (
          groups.map(([label, items]) => (
            <section key={label} className="session-group">
              <h2 className="rail-label">{label}</h2>
              {items.map((session) => {
                const active = session.id === activeSessionId;
                const editing = session.id === editingId;
                return (
                  <div key={session.id} className={`session-row${active ? ' is-active' : ''}`}>
                    {editing ? (
                      <form
                        className="session-rename"
                        onSubmit={(event) => {
                          event.preventDefault();
                          commitRename(session.id);
                        }}
                      >
                        <input
                          ref={renameRef}
                          value={draft}
                          maxLength={120}
                          aria-label="Session title"
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => commitRename(session.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setEditingId(null);
                            }
                          }}
                        />
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="session-main"
                        onClick={() => onOpenSession(session.id)}
                        disabled={running && !active}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span
                          className={`session-dot${
                            active && running
                              ? ' is-running'
                              : active && pendingApprovals > 0
                                ? ' is-waiting'
                                : active
                                  ? ' is-active'
                                  : ''
                          }`}
                          aria-hidden="true"
                        />
                        <span className="session-copy">
                          <span className="session-title">
                            {session.title || 'Untitled session'}
                          </span>
                          <span
                            className="session-meta mono"
                            title={`spend: ${spendLabel(session.costUsd, session.unpricedTokens)}`}
                          >
                            {session.model} · {relativeTime(session.updatedAt)} ·{' '}
                            {spendLabel(session.costUsd, session.unpricedTokens)}
                          </span>
                        </span>
                      </button>
                    )}
                    {!editing ? (
                      <div className="session-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Fork session"
                          title="Fork session — branch this conversation into a new session"
                          disabled={running}
                          onClick={() => onForkSession(session.id)}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Export session as Markdown"
                          title="Export session as Markdown"
                          disabled={running}
                          onClick={() => onExportSession(session.id)}
                        >
                          <Icon name="file" size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Rename session"
                          title="Rename session"
                          disabled={running}
                          onClick={() => startRename(session)}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                        <button
                          type="button"
                          className={`icon-button${confirmId === session.id ? ' is-confirm' : ''}`}
                          aria-label={
                            confirmId === session.id ? 'Confirm delete session' : 'Delete session'
                          }
                          title={
                            confirmId === session.id ? 'Click again to delete' : 'Delete session'
                          }
                          disabled={running}
                          onClick={() => requestDelete(session.id)}
                        >
                          {confirmId === session.id ? (
                            <span className="confirm-label mono">sure?</span>
                          ) : (
                            <Icon name="trash" size={13} />
                          )}
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>

      <div className="rail-footer">
        <div className="mcp-line" data-testid="mcp-line">
          <span
            className={`status-dot${
              mcpFailing.length > 0 ? ' is-fail' : mcpStatus.servers.length > 0 ? ' is-live' : ''
            }`}
          />
          <span>
            MCP {mcpStatus.servers.length} live · {mcpStatus.tools} tools
            {mcpFailing.length > 0 ? ` · ${mcpFailing.join(', ')} failed` : ''}
          </span>
        </div>
        <button type="button" className="rail-foot-button" onClick={onDiagnostics}>
          <Icon name="settings" size={14} />
          Diagnostics
        </button>
      </div>
    </aside>
  );
}
