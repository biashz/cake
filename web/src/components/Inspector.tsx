import { useEffect, useMemo, useState } from 'react';
import { formatCost } from '../../../src/core/cost.js';
import type {
  DoctorReportPayload,
  InitPayload,
  SessionInfo,
  TokenTotals,
} from '../../../src/desktop/api.js';
import { changeStats, type FileChange } from '../changes';
import { Icon } from './Icons';
import { DiffView } from './ToolCard';

export type InspectorTab = 'changes' | 'context' | 'files';

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'context', label: 'Context' },
  { id: 'files', label: 'Files' },
];

function tokenLabel(tokens: number | undefined): string {
  if (tokens === undefined) return '—';
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function RuleList({ label, rules }: { label: string; rules: string[] }) {
  return (
    <div className="rule-group">
      <div className="rule-heading">
        <span>{label}</span>
        <span className="mono">{rules.length}</span>
      </div>
      {rules.length === 0 ? (
        <p className="inspect-hint">No {label.toLowerCase()} rules.</p>
      ) : (
        <ul className="rule-list">
          {rules.slice(0, 6).map((rule) => (
            <li key={rule} className="mono">
              {rule}
            </li>
          ))}
          {rules.length > 6 ? <li className="inspect-hint">+{rules.length - 6} more</li> : null}
        </ul>
      )}
    </div>
  );
}

function ChangesPanel({ changes }: { changes: FileChange[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const stats = changeStats(changes);

  if (changes.length === 0) {
    return (
      <div className="inspect-empty">
        <Icon name="file" size={22} />
        <p>No file changes yet.</p>
        <p className="inspect-hint">Edits appear here as cake writes files.</p>
      </div>
    );
  }

  return (
    <div className="changes-panel">
      <p className="inspect-summary mono">
        {stats.files} file{stats.files === 1 ? '' : 's'} changed ·{' '}
        <span className="diff-count-add">+{stats.adds}</span>{' '}
        <span className="diff-count-remove">−{stats.removes}</span>
      </p>
      <div className="change-list">
        {changes.map((change) => {
          const open = expanded === change.path;
          return (
            <div key={change.path} className={`change-row${open ? ' is-open' : ''}`}>
              <button
                type="button"
                className="change-main"
                onClick={() => setExpanded(open ? null : change.path)}
                aria-expanded={open}
              >
                <Icon name="file" size={14} />
                <span className="change-path mono" title={change.path}>
                  {change.path}
                </span>
                <span className="change-stats mono">
                  <span className="diff-count-add">+{change.adds}</span>
                  <span className="diff-count-remove">−{change.removes}</span>
                </span>
                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
              </button>
              {open ? <DiffView lines={change.diff} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Inspector({
  init,
  session,
  used,
  lastUsage,
  changes,
  tab,
  doctor,
  doctorBusy,
  onTab,
  onClose,
  onRunDoctor,
  onReloadMcp,
  onInsertFile,
}: {
  init: InitPayload;
  session: SessionInfo | null;
  used: number;
  lastUsage: TokenTotals | null;
  changes: FileChange[];
  tab: InspectorTab;
  doctor: DoctorReportPayload | null;
  doctorBusy: boolean;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  onRunDoctor: () => void;
  onReloadMcp: () => void;
  onInsertFile: (path: string) => void;
}) {
  const [fileQuery, setFileQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const activeProvider = init.providers.find((item) => item.id === init.model.provider);

  useEffect(() => {
    if (tab !== 'files') return;
    let cancelled = false;
    setFilesLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const list = (await window.cake?.listFiles(fileQuery)) ?? [];
          if (!cancelled) setFiles(list);
        } finally {
          if (!cancelled) setFilesLoading(false);
        }
      })();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, fileQuery]);

  const contextPercent =
    activeProvider && activeProvider.maxContext > 0
      ? Math.round(Math.min(used / activeProvider.maxContext, 1) * 100)
      : 0;

  const doctorFails = useMemo(
    () => doctor?.checks.filter((check) => check.status === 'fail').length ?? 0,
    [doctor],
  );

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div className="tab-list" role="tablist" aria-label="Inspector sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => onTab(item.id)}
            >
              {item.label}
              {item.id === 'changes' && changes.length > 0 ? (
                <span className="tab-count mono">{changes.length}</span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Hide inspector"
          title="Hide inspector"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="inspector-body">
        {tab === 'changes' ? <ChangesPanel changes={changes} /> : null}

        {tab === 'context' ? (
          <div className="context-panel">
            <section className="inspect-section">
              <h3 className="inspect-heading">Usage</h3>
              <dl className="stat-grid">
                <div>
                  <dt>Session tokens</dt>
                  <dd className="mono">{tokenLabel(session?.totalTokens ?? 0)}</dd>
                </div>
                <div>
                  <dt>Session cost</dt>
                  <dd className="mono">{formatCost(session?.costUsd ?? 0)}</dd>
                </div>
                <div>
                  <dt>Last turn</dt>
                  <dd className="mono">
                    {lastUsage
                      ? `${tokenLabel(lastUsage.inputTokens)} in / ${tokenLabel(lastUsage.outputTokens)} out`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Context window</dt>
                  <dd className="mono">
                    {contextPercent}% of {tokenLabel(activeProvider?.maxContext ?? 0)}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="inspect-section">
              <h3 className="inspect-heading">Permission rules</h3>
              <RuleList label="Allow" rules={init.rules.allow} />
              <RuleList label="Deny" rules={init.rules.deny} />
            </section>

            <section className="inspect-section">
              <div className="section-heading-row">
                <h3 className="inspect-heading">MCP servers</h3>
                <button
                  type="button"
                  className="text-button"
                  onClick={onReloadMcp}
                  disabled={!init.workspace}
                >
                  Reload
                </button>
              </div>
              {init.mcpStatus.servers.length === 0 ? (
                <p className="inspect-hint">
                  No servers configured. Add `.cake/mcp.json` in this workspace.
                </p>
              ) : (
                <ul className="server-list">
                  {init.mcpStatus.servers.map((server) => (
                    <li key={server} className="server-row">
                      <span className="status-dot is-live" />
                      <span className="mono">{server}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="inspect-hint mono">{init.mcpStatus.tools} tools exposed</p>
              {init.mcpStatus.warnings.map((warning) => (
                <p key={warning} className="inspect-warning">
                  {warning}
                </p>
              ))}
            </section>

            <section className="inspect-section">
              <div className="section-heading-row">
                <h3 className="inspect-heading">Diagnostics</h3>
                <button
                  type="button"
                  className="text-button"
                  onClick={onRunDoctor}
                  disabled={doctorBusy}
                >
                  {doctorBusy ? 'Checking…' : 'Run checks'}
                </button>
              </div>
              {doctor ? (
                <>
                  <p className={`doctor-summary ${doctor.ok ? 'is-ok' : 'is-bad'}`}>
                    {doctor.ok
                      ? 'Environment is ready.'
                      : `${doctorFails} check${doctorFails === 1 ? '' : 's'} failed.`}
                  </p>
                  <ul className="doctor-list">
                    {doctor.checks.map((check) => (
                      <li key={check.label} className="doctor-row">
                        <span className={`status-dot is-${check.status}`} />
                        <span className="doctor-label">{check.label}</span>
                        <span className="doctor-detail mono" title={check.detail}>
                          {check.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="inspect-hint">
                  Check Node, provider keys, config, MCP, sessions, and the code index without
                  calling a model.
                </p>
              )}
            </section>
          </div>
        ) : null}

        {tab === 'files' ? (
          <div className="files-panel">
            <label className="files-search">
              <Icon name="search" size={14} />
              <input
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                placeholder="Filter workspace files"
                spellCheck={false}
                aria-label="Filter workspace files"
              />
            </label>
            <p className="inspect-hint">Click a file to add `@path` to the prompt.</p>
            <div className="file-list">
              {filesLoading && files.length === 0 ? (
                <p className="inspect-hint">Loading files…</p>
              ) : files.length === 0 ? (
                <p className="inspect-hint">No files match that filter.</p>
              ) : (
                files.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className="file-row"
                    onClick={() => onInsertFile(file)}
                    title={`Add @${file}`}
                  >
                    <Icon name="file" size={13} />
                    <span className="mono">{file}</span>
                    <span className="file-action mono">@</span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export { TABS as INSPECTOR_TABS };
