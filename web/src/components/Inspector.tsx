import { useEffect, useMemo, useRef, useState } from 'react';
import { spendLabel } from '../../../src/core/cost.js';
import type { CostGroup, CostRow, CostTurn } from '../../../src/core/cost-board.js';
import { planProgress } from '../../../src/core/plan.js';
import type { Pricing } from '../../../src/core/pricing.js';
import type {
  ContextPayload,
  CostPayload,
  DoctorFixPayload,
  DoctorReportPayload,
  InitPayload,
  McpDraft,
  McpServerRow,
  McpStatus,
  PermissionClass,
  PricingRow,
  RuleListName,
  RuleMove,
  RuleRow,
  RuleScopeName,
  RulesPayload,
  SessionInfo,
  TokenTotals,
} from '../../../src/desktop/api.js';
import { parseRule } from '../../../src/permissions/rules.js';
import type { TaskItem, TaskStatus } from '../../../src/tools/types.js';
import { changeStats, type FileChange } from '../changes';
import { Icon } from './Icons';
import { SliceBlock } from './Slice';
import { DiffView } from './ToolCard';

export type InspectorTab = 'changes' | 'plan' | 'context' | 'cost' | 'files';

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'plan', label: 'Plan' },
  { id: 'context', label: 'Context' },
  { id: 'cost', label: 'Cost' },
  { id: 'files', label: 'Files' },
];

/** Same marks the kernel and the CLI use, so a plan reads alike everywhere. */
const PLAN_MARKS: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

const PLAN_WORDS: Record<TaskStatus, string> = {
  pending: 'not started',
  in_progress: 'in progress',
  completed: 'done',
};

function tokenLabel(tokens: number | undefined): string {
  if (tokens === undefined) return '—';
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

const SCOPE_WORDS: Record<RuleScopeName, string> = { project: 'workspace', global: 'global' };

/** What a rule will actually do, in the words the matcher uses. */
function ruleExplanation(rule: string, list: RuleListName): string {
  const parsed = parseRule(rule);
  if (!parsed) return '';
  const one = list === 'allow' ? 'runs without asking' : 'is blocked';
  const many = list === 'allow' ? 'run without asking' : 'are blocked';
  return parsed.pattern === undefined
    ? `Every ${parsed.tool} call ${one}.`
    : `${parsed.tool} calls matching ${parsed.pattern} ${many}.`;
}

function RuleRows({
  rows,
  list,
  pending,
  onRemove,
  onMove,
}: {
  rows: RuleRow[];
  list: RuleListName;
  pending: boolean;
  onRemove: (list: RuleListName, scope: RuleScopeName, rule: string) => void;
  onMove: (list: RuleListName, scope: RuleScopeName, rule: string, delta: RuleMove) => void;
}) {
  // Grouping is by scope so a move stays inside the file that holds the rule.
  const groups: Array<{ scope: RuleScopeName; items: RuleRow[] }> = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.scope === row.scope) last.items.push(row);
    else groups.push({ scope: row.scope, items: [row] });
  }
  const words = list === 'allow' ? 'Allow' : 'Deny';
  return (
    <div className="rule-group" data-testid={`rule-group-${list}`}>
      <div className="rule-heading">
        <span>{words}</span>
        <span className="mono">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="inspect-hint">No {words.toLowerCase()} rules.</p>
      ) : (
        groups.map((group) => (
          <div key={group.scope} className="rule-scope-block">
            <div className="rule-scope-label mono">{SCOPE_WORDS[group.scope]}</div>
            <ul className="rule-list">
              {group.items.map((row, index) => (
                <li key={row.rule} className="rule-row">
                  <span className="mono rule-text" title={row.rule}>
                    {row.rule}
                  </span>
                  <span className="rule-actions">
                    <button
                      type="button"
                      className="rule-move mono"
                      aria-label={`Move ${row.rule} up`}
                      title="Move up"
                      disabled={pending || index === 0}
                      onClick={() => onMove(list, row.scope, row.rule, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="rule-move mono"
                      aria-label={`Move ${row.rule} down`}
                      title="Move down"
                      disabled={pending || index === group.items.length - 1}
                      onClick={() => onMove(list, row.scope, row.rule, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Remove ${row.rule}`}
                      disabled={pending}
                      onClick={() => onRemove(list, row.scope, row.rule)}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

export function RulesSection({
  rules,
  hasWorkspace,
  onSetRule,
  onMoveRule,
}: {
  rules: RulesPayload;
  hasWorkspace: boolean;
  onSetRule: (
    action: 'add' | 'remove',
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
  ) => Promise<void>;
  onMoveRule: (
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
    delta: RuleMove,
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [list, setList] = useState<RuleListName>('allow');
  const [scope, setScope] = useState<RuleScopeName>('project');
  const [pending, setPending] = useState(false);

  const rule = draft.trim();
  const parsed = rule ? parseRule(rule) : null;
  const file = rules.files[scope];

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
      setDraft('');
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="inspect-section" data-testid="rules-section">
      <div className="section-heading-row">
        <h3 className="inspect-heading">Permission rules</h3>
        <span className="inspect-hint mono">deny wins</span>
      </div>

      <RuleRows
        rows={rules.allow}
        list="allow"
        pending={pending}
        onRemove={(at, from, text) => void run(() => onSetRule('remove', at, from, text))}
        onMove={(at, from, text, delta) => void run(() => onMoveRule(at, from, text, delta))}
      />
      <RuleRows
        rows={rules.deny}
        list="deny"
        pending={pending}
        onRemove={(at, from, text) => void run(() => onSetRule('remove', at, from, text))}
        onMove={(at, from, text, delta) => void run(() => onMoveRule(at, from, text, delta))}
      />

      {rules.conflicts.length > 0 ? (
        <p className="inspect-warning">
          In both lists, so the allow does nothing: {rules.conflicts.join(', ')}
        </p>
      ) : null}

      {hasWorkspace ? (
        <>
          <div className="rule-pair">
            <label className="rate-field">
              <span>List</span>
              <select value={list} onChange={(e) => setList(e.target.value as RuleListName)}>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </label>
            <label className="rate-field">
              <span>Scope</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as RuleScopeName)}>
                <option value="project">This workspace</option>
                <option value="global">Every workspace</option>
              </select>
            </label>
          </div>
          <label className="rate-field">
            <span>Rule</span>
            <input
              value={draft}
              spellCheck={false}
              placeholder="bash(git log *)"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && parsed && !pending)
                  void run(() => onSetRule('add', list, scope, rule));
              }}
            />
          </label>
          <div className="rate-actions">
            <button
              type="button"
              className="primary"
              disabled={!parsed || pending}
              onClick={() => void run(() => onSetRule('add', list, scope, rule))}
            >
              Add rule
            </button>
          </div>
          <p className={`rule-preview${parsed ? '' : ' is-empty'}`}>
            {parsed ? ruleExplanation(rule, list) : 'Use tool or tool(pattern).'}
          </p>
          {file ? <p className="inspect-hint mono">{file}</p> : null}
          <p className="inspect-hint">
            Order is for reading; a deny blocks whatever its place in either list.
          </p>
        </>
      ) : (
        <p className="inspect-hint">Open a workspace to edit rules.</p>
      )}
    </section>
  );
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

interface ServerForm {
  scope: RuleScopeName;
  transport: 'stdio' | 'http';
  name: string;
  command: string;
  args: string;
  url: string;
  permission: 'auto' | PermissionClass;
}

const NEW_SERVER: ServerForm = {
  scope: 'project',
  transport: 'stdio',
  name: '',
  command: '',
  args: '',
  url: '',
  permission: 'auto',
};

/** Start an edit from what the file really holds, not from what the form expects. */
function formOf(row: McpServerRow): ServerForm {
  const base = {
    scope: row.scope,
    name: row.name,
    permission: row.permission ?? ('auto' as const),
  };
  return 'command' in row.target
    ? {
        ...base,
        transport: 'stdio',
        command: row.target.command,
        args: row.target.args.join(' '),
        url: '',
      }
    : { ...base, transport: 'http', command: '', args: '', url: row.target.url };
}

function targetOf(row: McpServerRow): string {
  return 'command' in row.target
    ? [row.target.command, ...row.target.args].join(' ')
    : row.target.url;
}

/** Mirrors the kernel's checks so Save cannot promise a write that would fail. */
function serverProblem(form: ServerForm): string | null {
  const name = form.name.trim();
  if (!name) return 'Name the server first.';
  if (!SERVER_NAME.test(name)) {
    return 'Names start with a letter or digit; dots, dashes and underscores are fine.';
  }
  if (form.transport === 'stdio') {
    return form.command.trim() ? null : 'A stdio server needs the command cake starts.';
  }
  try {
    const { protocol } = new URL(form.url.trim());
    if (protocol === 'http:' || protocol === 'https:') return null;
  } catch {
    // Expected while typing; the message below is the point.
  }
  return 'An http server needs a full URL, like https://api.test/mcp.';
}

function draftOf(form: ServerForm): McpDraft {
  const permission = form.permission === 'auto' ? {} : { permission: form.permission };
  if (form.transport === 'stdio') {
    const args = form.args.trim();
    return {
      name: form.name.trim(),
      transport: 'stdio',
      command: form.command.trim(),
      args: args ? args.split(/\s+/) : [],
      ...permission,
    };
  }
  return { name: form.name.trim(), transport: 'http', url: form.url.trim(), ...permission };
}

function serverPreview(form: ServerForm): string {
  if (form.transport === 'stdio') {
    const line = [form.command.trim(), form.args.trim()].filter(Boolean).join(' ');
    return `Starts ${line} and reads its tools over stdio.`;
  }
  return `Connects to ${form.url.trim()} over HTTP.`;
}

function serverState(row: McpServerRow): { dot: string; label: string } {
  if (!row.enabled) return { dot: 'is-missing', label: 'off' };
  if (row.connected) {
    return { dot: 'is-live', label: `${row.tools} tool${row.tools === 1 ? '' : 's'}` };
  }
  return { dot: 'is-fail', label: 'failed' };
}

export function McpSection({
  mcp,
  hasWorkspace,
  onReload,
  onSetServer,
  onToggleServer,
  onRemoveServer,
}: {
  mcp: McpStatus;
  hasWorkspace: boolean;
  onReload: () => Promise<void>;
  onSetServer: (scope: RuleScopeName, draft: McpDraft) => Promise<void>;
  onToggleServer: (scope: RuleScopeName, name: string, enabled: boolean) => Promise<void>;
  onRemoveServer: (scope: RuleScopeName, name: string) => Promise<void>;
}) {
  const [form, setForm] = useState<ServerForm>(NEW_SERVER);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const problem = serverProblem(form);
  const file = mcp.files[form.scope];

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  };

  const save = () =>
    void run(async () => {
      await onSetServer(form.scope, draftOf(form));
      setEditing(null);
      setForm(NEW_SERVER);
    });

  return (
    <section className="inspect-section" data-testid="mcp-section">
      <div className="section-heading-row">
        <h3 className="inspect-heading">MCP servers</h3>
        <button
          type="button"
          className="text-button"
          onClick={() => void run(onReload)}
          disabled={!hasWorkspace || pending}
        >
          Reload
        </button>
      </div>

      {mcp.rows.length === 0 ? (
        <p className="inspect-hint">{hasWorkspace ? 'No servers yet.' : 'No servers.'}</p>
      ) : (
        <ul className="server-list">
          {mcp.rows.map((row) => {
            const state = serverState(row);
            return (
              <li
                key={`${row.scope}:${row.name}`}
                className="server-item"
                data-testid={`mcp-row-${row.name}`}
              >
                <div className="server-row">
                  <span className={`status-dot ${state.dot}`} />
                  <span className="mono server-name">{row.name}</span>
                  <span className="server-state">{state.label}</span>
                  <span className="rule-actions">
                    {row.enabled ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={pending || !hasWorkspace}
                        aria-label={`Switch off ${row.name}`}
                        onClick={() => void run(() => onToggleServer(row.scope, row.name, false))}
                      >
                        Off
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="text-button"
                        disabled={pending || !hasWorkspace}
                        aria-label={`Switch on ${row.name}`}
                        onClick={() => void run(() => onToggleServer(row.scope, row.name, true))}
                      >
                        On
                      </button>
                    )}
                    {hasWorkspace ? (
                      <>
                        <button
                          type="button"
                          className="text-button"
                          disabled={pending}
                          aria-label={`Edit ${row.name}`}
                          onClick={() => {
                            setEditing(row.name);
                            setForm(formOf(row));
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={pending}
                          aria-label={`Remove ${row.name}`}
                          onClick={() => void run(() => onRemoveServer(row.scope, row.name))}
                        >
                          Remove
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
                <p className="server-target mono">{targetOf(row)}</p>
                {row.error ? <p className="inspect-warning">{row.error}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      {mcp.changes.length > 0 ? (
        <ul className="server-changes" data-testid="mcp-changes">
          {mcp.changes.map((line) => (
            <li key={line} className="inspect-hint mono">
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {mcp.warnings.map((warning) => (
        <p key={warning} className="inspect-warning">
          {warning}
        </p>
      ))}

      {hasWorkspace ? (
        <>
          <div className="rule-pair">
            <label className="rate-field">
              <span>Scope</span>
              <select
                value={form.scope}
                onChange={(event) =>
                  setForm({ ...form, scope: event.target.value as RuleScopeName })
                }
              >
                <option value="project">This workspace</option>
                <option value="global">Every workspace</option>
              </select>
            </label>
            <label className="rate-field">
              <span>Transport</span>
              <select
                value={form.transport}
                onChange={(event) =>
                  setForm({ ...form, transport: event.target.value as 'stdio' | 'http' })
                }
              >
                <option value="stdio">Command (stdio)</option>
                <option value="http">URL (http)</option>
              </select>
            </label>
          </div>
          <label className="rate-field">
            <span>Name</span>
            <input
              value={form.name}
              spellCheck={false}
              disabled={editing !== null}
              placeholder="filesystem"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !problem && !pending) save();
              }}
            />
          </label>
          {form.transport === 'stdio' ? (
            <>
              <label className="rate-field">
                <span>Command</span>
                <input
                  value={form.command}
                  spellCheck={false}
                  placeholder="npx"
                  onChange={(event) => setForm({ ...form, command: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !problem && !pending) save();
                  }}
                />
              </label>
              <label className="rate-field">
                <span>Arguments</span>
                <input
                  value={form.args}
                  spellCheck={false}
                  placeholder="-y @acme/mcp-server"
                  onChange={(event) => setForm({ ...form, args: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !problem && !pending) save();
                  }}
                />
              </label>
            </>
          ) : (
            <label className="rate-field">
              <span>URL</span>
              <input
                value={form.url}
                spellCheck={false}
                placeholder="https://api.test/mcp"
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !problem && !pending) save();
                }}
              />
            </label>
          )}
          <label className="rate-field">
            <span>Permission</span>
            <select
              value={form.permission}
              onChange={(event) =>
                setForm({ ...form, permission: event.target.value as ServerForm['permission'] })
              }
            >
              <option value="auto">From the tool itself</option>
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="shell">Shell</option>
            </select>
          </label>
          <div className="rate-actions">
            <button
              type="button"
              className="primary"
              disabled={Boolean(problem) || pending}
              onClick={save}
            >
              {editing ? 'Save server' : 'Add server'}
            </button>
            {editing ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setEditing(null);
                  setForm(NEW_SERVER);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
          <p className={`rule-preview${problem ? ' is-empty' : ''}`}>
            {problem ?? serverPreview(form)}
          </p>
          {file ? <p className="inspect-hint mono">{file}</p> : null}
          <p className="inspect-hint">
            Saving rewrites this entry only; `env`, `cwd` and `headers` stay a file edit. Arguments
            split on spaces. A workspace server replaces a global one of the same name.
            {editing ? ' To rename, remove it and add it again.' : ''}
          </p>
        </>
      ) : (
        <p className="inspect-hint">Open a workspace to edit servers.</p>
      )}
    </section>
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
              {open ? <DiffView diff={change.diff} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The model's own checklist, live from the kernel. Progress is derived from the
 * statuses rather than reported by the model, so it cannot drift from the list.
 */
export function PlanPanel({ tasks }: { tasks: TaskItem[] }) {
  const progress = planProgress(tasks);

  if (tasks.length === 0) {
    return (
      <div className="inspect-empty">
        <Icon name="check" size={22} />
        <p>No plan yet.</p>
        <p className="inspect-hint">Ask cake to plan a multi-step job and the steps track here.</p>
      </div>
    );
  }

  const share = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);

  return (
    <div className="plan-panel" data-testid="plan-panel">
      <div className="plan-head">
        <span className="plan-progress mono">
          {progress.done} of {progress.total} done
        </span>
        {progress.active > 0 ? (
          <span className="plan-active mono">{progress.active} active</span>
        ) : null}
      </div>
      <div
        className="plan-bar"
        role="progressbar"
        aria-label="Plan progress"
        aria-valuenow={progress.done}
        aria-valuemin={0}
        aria-valuemax={progress.total}
      >
        <span className="plan-bar-fill" style={{ width: `${share}%` }} />
      </div>
      <ol className="plan-list">
        {tasks.map((task) => (
          <li key={task.id} className={`plan-item plan-${task.status}`}>
            <span className="plan-mark mono" aria-hidden="true">
              {PLAN_MARKS[task.status]}
            </span>
            <span className="plan-subject">{task.subject}</span>
            <span className="sr-only">{PLAN_WORDS[task.status]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Rates are money: drop the decimals that carry no information. */
function rateLabel(value: number): string {
  return `$${Number(value.toFixed(4))}`;
}

/** The two fields as a rate, or null while either is unusable. */
function parseRates(input: string, output: string): Pricing | null {
  if (!input.trim() || !output.trim()) return null;
  const inRate = Number(input);
  const outRate = Number(output);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;
  if (inRate < 0 || outRate < 0) return null;
  return { inputPer1M: inRate, outputPer1M: outRate };
}

function RateTable({
  rows,
  onRemove,
  busy = false,
}: {
  rows: PricingRow[];
  onRemove?: (pattern: string) => void;
  busy?: boolean;
}) {
  return (
    <div className="rate-table">
      <div className="rate-row rate-head mono">
        <span>Pattern</span>
        <span className="rate-value">In</span>
        <span className="rate-value">Out</span>
        <span className="rate-slot" />
      </div>
      {rows.map((row) => (
        <div key={row.pattern} className="rate-row mono">
          <span className="rate-pattern" title={row.pattern}>
            {row.pattern}
          </span>
          <span className="rate-value">{rateLabel(row.inputPer1M)}</span>
          <span className="rate-value">{rateLabel(row.outputPer1M)}</span>
          <span className="rate-slot">
            {onRemove ? (
              <button
                type="button"
                className="text-button"
                onClick={() => onRemove(row.pattern)}
                disabled={busy}
              >
                Remove
              </button>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Turns are listed by clock time, not by the moment's full timestamp. */
function shortTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One billed model call inside a turn: who ran it, what it cost. */
function BoardLine({ row }: { row: CostRow }) {
  return (
    <div className="board-line" data-testid="cost-line">
      <span className="board-who">
        {row.scope === 'main'
          ? 'Main model'
          : row.agentType
            ? `Subagent: ${row.agentType}`
            : 'Nested work'}
      </span>
      <span className="board-model mono">{`${row.provider}/${row.model}`}</span>
      <span className="board-value mono">{tokenLabel(row.totalTokens)}</span>
      <span className="board-value mono">
        {spendLabel(row.costUsd, row.priced ? 0 : row.totalTokens)}
      </span>
    </div>
  );
}

function BoardTurn({ turn }: { turn: CostTurn }) {
  return (
    <details className="board-turn" data-testid="cost-turn-row">
      <summary>
        <span className="board-num mono">{turn.turn}</span>
        <span className="board-when mono">{shortTime(turn.occurredAt)}</span>
        <span className="board-value mono">{tokenLabel(turn.totalTokens)}</span>
        <span className="board-value mono">{spendLabel(turn.costUsd, turn.unpricedTokens)}</span>
      </summary>
      <div className="board-lines">
        {turn.rows.map((row) => (
          <BoardLine
            key={`${row.provider}/${row.model}/${row.scope}/${row.agentType}/${row.seq}`}
            row={row}
          />
        ))}
      </div>
    </details>
  );
}

/**
 * A spend group. `onPriceModel` only appears for model groups, whose key is
 * already a `provider/model` pattern; a work group has nothing to price.
 */
function BoardGroup({
  group,
  onPriceModel,
}: {
  group: CostGroup;
  onPriceModel?: (pattern: string) => void;
}) {
  const unpriced = group.unpricedTokens > 0;
  return (
    <div className="board-row" data-testid="cost-group-row">
      <span className="board-who">{group.label}</span>
      <span className="board-value mono" title={`${group.totalTokens} tokens`}>
        {tokenLabel(group.totalTokens)}
      </span>
      <span className="board-value mono" title={`${group.turns} turn(s)`}>
        {spendLabel(group.costUsd, group.unpricedTokens)}
      </span>
      <span className="board-slot">
        {onPriceModel && unpriced ? (
          <button
            type="button"
            className="text-button"
            title={`No rate for ${group.key}; set one to estimate its spend`}
            onClick={() => onPriceModel(group.key)}
          >
            Set rate
          </button>
        ) : null}
      </span>
    </div>
  );
}

/**
 * What the session and the workspace spent, broken down by turn, model and nested
 * work, above the rate card that prices it. Saved rates live in this workspace's
 * `.cake/config.json`, so each project prices what it uses.
 */
export function CostPanel({
  cost,
  onSetPricing,
}: {
  cost: CostPayload;
  onSetPricing: (pattern: string, rates: Pricing | null) => Promise<void>;
}) {
  const [pattern, setPattern] = useState(`${cost.model.provider}/${cost.model.modelId}`);
  const [input, setInput] = useState(cost.effective ? String(cost.effective.inputPer1M) : '');
  const [output, setOutput] = useState(cost.effective ? String(cost.effective.outputPer1M) : '');
  const [pending, setPending] = useState(false);
  const patternInput = useRef<HTMLInputElement>(null);

  const rates = parseRates(input, output);
  const key = pattern.trim();
  // A bare word would price the provider's whole namespace, so ask for provider/model.
  const shapeOk = key.includes('/');

  /** From a board row that has no rate: put its model in the form and let it be typed. */
  const priceModel = (modelKey: string) => {
    setPattern(modelKey);
    setInput('');
    setOutput('');
    // Focusing alone brings the form into view, in the panel and in the OS.
    patternInput.current?.focus();
  };

  const write = async (next: Pricing | null, at: string) => {
    setPending(true);
    try {
      await onSetPricing(at, next);
    } finally {
      setPending(false);
    }
  };

  const board = cost.board;
  const totals = board?.totals;
  const billed = (totals?.totalTokens ?? 0) > 0 || (cost.rollup?.totalTokens ?? 0) > 0;
  // The session's own total can exceed the rows: turns billed before per-turn
  // detail was saved still cost something.
  const detailGap =
    cost.rollup !== null && totals !== undefined && cost.rollup.totalTokens > totals.totalTokens;

  return (
    <div className="cost-panel" data-testid="cost-panel">
      <section className="inspect-section">
        <div className="section-heading-row">
          <h3 className="inspect-heading">Session spend</h3>
          {totals && totals.turns > 0 ? (
            <span className="inspect-hint mono">{`${totals.turns} turn${
              totals.turns === 1 ? '' : 's'
            }`}</span>
          ) : null}
        </div>
        {billed ? (
          <>
            <p className="cost-spend mono" data-testid="cost-spend">
              {spendLabel(
                totals?.costUsd ?? cost.rollup?.costUsd ?? 0,
                totals?.unpricedTokens ?? 0,
              )}
            </p>
            {totals && totals.totalTokens > 0 ? (
              <dl className="stat-grid">
                <div>
                  <dt>Input</dt>
                  <dd className="mono">{tokenLabel(totals.inputTokens)}</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd className="mono">{tokenLabel(totals.outputTokens)}</dd>
                </div>
                <div>
                  <dt>Without a rate</dt>
                  <dd className={`mono${totals.unpricedTokens > 0 ? ' is-unpriced' : ''}`}>
                    {tokenLabel(totals.unpricedTokens)}
                  </dd>
                </div>
              </dl>
            ) : null}
            {detailGap && cost.rollup ? (
              <p className="inspect-hint" data-testid="cost-detail-note">
                {`Per-turn detail covers ${tokenLabel(totals?.totalTokens ?? 0)} of the ${tokenLabel(
                  cost.rollup.totalTokens,
                )} this session used; earlier turns saved only the total.`}
              </p>
            ) : null}
            {(totals?.turns ?? 0) === 0 ? (
              <p className="inspect-hint">
                No per-turn detail saved, so the total covers turns cake billed before this session
                kept rows.
              </p>
            ) : null}
          </>
        ) : (
          <p className="inspect-hint">
            Nothing billed yet in this session. Spend appears here turn by turn.
          </p>
        )}
      </section>

      {board && board.turns.length > 0 ? (
        <section className="inspect-section">
          <div className="section-heading-row">
            <h3 className="inspect-heading">By turn</h3>
            <span className="inspect-hint">newest first</span>
          </div>
          <div className="board-list">
            {board.turns.map((turn) => (
              <BoardTurn key={turn.turn} turn={turn} />
            ))}
          </div>
          {board.truncated ? (
            <p className="inspect-hint" data-testid="cost-truncated">
              {`Older than the ${board.turns.length} turns shown is grouped but not listed.`}
            </p>
          ) : null}
        </section>
      ) : null}

      {board && board.models.length > 0 ? (
        <section className="inspect-section">
          <h3 className="inspect-heading">By model</h3>
          <div className="board-list">
            {board.models.map((group) => (
              <BoardGroup key={group.key} group={group} onPriceModel={priceModel} />
            ))}
          </div>
        </section>
      ) : null}

      {board && board.work.length > 0 ? (
        <section className="inspect-section">
          <h3 className="inspect-heading">By work</h3>
          <div className="board-list">
            {board.work.map((group) => (
              <BoardGroup key={group.key} group={group} />
            ))}
          </div>
          <p className="inspect-hint">
            Nested work is what child agents used; it is part of the same turn, not an extra bill.
          </p>
        </section>
      ) : null}

      <section className="inspect-section">
        <h3 className="inspect-heading">This workspace</h3>
        {cost.workspace ? (
          <dl className="stat-grid" data-testid="cost-workspace">
            <div>
              <dt>Sessions</dt>
              <dd className="mono">{cost.workspace.sessions}</dd>
            </div>
            <div>
              <dt>Total spend</dt>
              <dd className="mono">
                {spendLabel(cost.workspace.costUsd, cost.workspace.unpricedTokens)}
              </dd>
            </div>
            <div>
              <dt>Total tokens</dt>
              <dd className="mono">{tokenLabel(cost.workspace.totalTokens)}</dd>
            </div>
          </dl>
        ) : (
          <p className="inspect-hint">Nothing to total until a workspace is open.</p>
        )}
      </section>

      <section className="inspect-section">
        <h3 className="inspect-heading">Rate in use</h3>
        <p className="cost-model mono">
          {cost.model.provider}/{cost.model.modelId}
        </p>
        {cost.effective ? (
          <>
            <dl className="stat-grid">
              <div>
                <dt>Input per 1M</dt>
                <dd className="mono">{rateLabel(cost.effective.inputPer1M)}</dd>
              </div>
              <div>
                <dt>Output per 1M</dt>
                <dd className="mono">{rateLabel(cost.effective.outputPer1M)}</dd>
              </div>
            </dl>
            <p className="inspect-hint">
              {cost.source === 'config' ? 'From this workspace’s config' : 'From cake’s card'} as{' '}
              <span className="mono">{cost.effective.pattern}</span>.
            </p>
          </>
        ) : (
          <p className="inspect-warning">
            No price set for this model. Set a rate below; without one its spend cannot be
            estimated.
          </p>
        )}
      </section>

      <section className="inspect-section">
        <h3 className="inspect-heading">Workspace rates</h3>
        {cost.overrides.length === 0 ? (
          <p className="inspect-hint">None set, so the built-in card applies.</p>
        ) : (
          <RateTable rows={cost.overrides} busy={pending} onRemove={(at) => void write(null, at)} />
        )}
      </section>

      <section className="inspect-section">
        <h3 className="inspect-heading">Set a rate</h3>
        {cost.configFile ? (
          <>
            <label className="rate-field">
              <span>Pattern</span>
              <input
                ref={patternInput}
                value={pattern}
                onChange={(event) => setPattern(event.target.value)}
                placeholder="anthropic/sonnet"
                spellCheck={false}
              />
            </label>
            <div className="rate-pair">
              <label className="rate-field">
                <span>Input $/1M</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                />
              </label>
              <label className="rate-field">
                <span>Output $/1M</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={output}
                  onChange={(event) => setOutput(event.target.value)}
                />
              </label>
            </div>
            <div className="rate-actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (rates && shapeOk) void write(rates, key);
                }}
                disabled={!rates || !shapeOk || pending}
              >
                {pending ? 'Saving…' : 'Save rate'}
              </button>
              {!shapeOk ? <span className="inspect-hint">Use provider/model.</span> : null}
            </div>
            <p className="inspect-hint mono" title={cost.configFile}>
              {cost.configFile}
            </p>
          </>
        ) : (
          <p className="inspect-hint">Open a workspace to store rates.</p>
        )}
      </section>

      <section className="inspect-section">
        <h3 className="inspect-heading">Built-in card</h3>
        <RateTable rows={cost.builtin} />
        <p className="inspect-hint">Indicative list prices; a workspace rate wins.</p>
      </section>
    </div>
  );
}

/** What a fix button says: each one names what pressing it does. */
function fixLabel(fix: DoctorFixPayload): string {
  switch (fix.kind) {
    case 'reindex':
      return 'Rebuild index';
    case 'reload-mcp':
      return 'Reconnect servers';
    case 'open-workspace':
      return 'Open a workspace';
    case 'open-file':
      if (fix.target.startsWith('mcp')) return 'Open MCP config';
      if (fix.target.startsWith('settings')) return 'Open rules';
      return 'Open config';
    case 'reveal':
      return fix.target === 'sessions' ? 'Show sessions' : 'Show index';
    case 'set-key':
      return 'Save key';
  }
}

/**
 * One row's action. The busy state is local so two rows offering the same kind of
 * fix — keys for two providers, say — do not light up together.
 */
export function FixControl({
  fix,
  onApply,
}: {
  fix: DoctorFixPayload;
  onApply: (fix: DoctorFixPayload, value?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [key, setKey] = useState('');

  const run = async (value?: string) => {
    setPending(true);
    try {
      await onApply(fix, value);
      setKey('');
    } finally {
      setPending(false);
    }
  };

  if (fix.kind === 'set-key') {
    return (
      <form
        className="doctor-fix"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = key.trim();
          if (trimmed) void run(trimmed);
        }}
      >
        <input
          type="password"
          className="doctor-key"
          value={key}
          placeholder={fix.envVar}
          aria-label={`${fix.provider} API key`}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setKey(event.target.value)}
          disabled={pending}
        />
        <button
          type="submit"
          className="text-button"
          data-testid={`fix-${fix.provider}`}
          disabled={pending || key.trim() === ''}
        >
          {pending ? 'Saving…' : fixLabel(fix)}
        </button>
      </form>
    );
  }

  return (
    <button
      type="button"
      className="text-button doctor-fix"
      data-testid={`fix-${fix.kind}`}
      disabled={pending}
      onClick={() => void run()}
    >
      {pending ? 'Working…' : fixLabel(fix)}
    </button>
  );
}

export function Inspector({
  init,
  session,
  context,
  lastUsage,
  changes,
  plan,
  tab,
  doctor,
  doctorBusy,
  onTab,
  onClose,
  onRunDoctor,
  onApplyFix,
  onReloadMcp,
  onSetMcpServer,
  onToggleMcpServer,
  onRemoveMcpServer,
  onInsertFile,
  onSetPricing,
  onSetRule,
  onMoveRule,
}: {
  init: InitPayload;
  session: SessionInfo | null;
  context: ContextPayload | null;
  lastUsage: TokenTotals | null;
  changes: FileChange[];
  plan: TaskItem[];
  tab: InspectorTab;
  doctor: DoctorReportPayload | null;
  doctorBusy: boolean;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  onRunDoctor: () => void;
  onApplyFix: (fix: DoctorFixPayload, value?: string) => Promise<void>;
  onReloadMcp: () => Promise<void>;
  onSetMcpServer: (scope: RuleScopeName, draft: McpDraft) => Promise<void>;
  onToggleMcpServer: (scope: RuleScopeName, name: string, enabled: boolean) => Promise<void>;
  onRemoveMcpServer: (scope: RuleScopeName, name: string) => Promise<void>;
  onInsertFile: (path: string) => void;
  onSetPricing: (pattern: string, rates: Pricing | null) => Promise<void>;
  onSetRule: (
    action: 'add' | 'remove',
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
  ) => Promise<void>;
  onMoveRule: (
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
    delta: RuleMove,
  ) => Promise<void>;
}) {
  const [fileQuery, setFileQuery] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== 'files') return;
    let cancelled = false;
    setFilesLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const list = (await window.cake?.listFiles(fileQuery)) ?? [];
          if (cancelled) return;
          setFiles(list);
          setFilesError(null);
        } catch (err) {
          // A listing that failed is not a listing that came back empty, and the
          // panel says which of the two it is rather than showing you rows that
          // answer the filter you already changed.
          if (cancelled) return;
          setFilesError(err instanceof Error ? err.message : String(err));
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

  const doctorFails = useMemo(
    () => doctor?.checks.filter((check) => check.status === 'fail').length ?? 0,
    [doctor],
  );
  const doctorWarns = useMemo(
    () => doctor?.checks.filter((check) => check.status === 'warn').length ?? 0,
    [doctor],
  );

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="inspector-head">
        <div
          className="tab-list"
          role="tablist"
          aria-label="Inspector sections"
          onKeyDown={(event) => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
            event.preventDefault();
            const position = TABS.findIndex((item) => item.id === tab);
            const size = TABS.length;
            const to =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? size - 1
                  : (position + step + size) % size;
            const next = TABS[to];
            if (!next || next.id === tab) return;
            // The buttons stay in the DOM, so focus can follow the selection at once.
            onTab(next.id);
            document.getElementById(`tab-${next.id}`)?.focus();
          }}
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="inspector-panel"
              tabIndex={tab === item.id ? 0 : -1}
              className={`tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => onTab(item.id)}
            >
              {item.label}
              {item.id === 'changes' && changes.length > 0 ? (
                <span className="tab-count mono">{changes.length}</span>
              ) : null}
              {item.id === 'plan' && plan.length > 0 ? (
                <span className="tab-count mono">
                  {planProgress(plan).done}/{plan.length}
                </span>
              ) : null}
              {item.id === 'cost' && !init.cost.effective ? (
                <>
                  <span className="tab-flag" aria-hidden="true" />
                  <span className="sr-only">no price set</span>
                </>
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

      <div
        className="inspector-body"
        id="inspector-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'changes' ? <ChangesPanel changes={changes} /> : null}
        {tab === 'plan' ? <PlanPanel tasks={plan} /> : null}

        {tab === 'context' ? (
          <div className="context-panel">
            <section className="inspect-section">
              <div className="section-heading-row">
                <h3 className="inspect-heading">Context layers</h3>
                <span className="inspect-hint mono">est.</span>
              </div>
              <SliceBlock context={context} />
            </section>

            <section className="inspect-section">
              <h3 className="inspect-heading">Usage</h3>
              <dl className="stat-grid">
                <div>
                  <dt>Session tokens</dt>
                  <dd className="mono">{tokenLabel(session?.totalTokens ?? 0)}</dd>
                </div>
                <div>
                  <dt>Session cost</dt>
                  {/* Tokens with no rate are counted, so their $0 is never read as free. */}
                  <dd className="mono">
                    {spendLabel(
                      init.cost.rollup?.costUsd ?? session?.costUsd ?? 0,
                      init.cost.board?.totals.unpricedTokens ?? 0,
                    )}
                  </dd>
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
                  <dt>Free left</dt>
                  <dd className="mono">{tokenLabel(context?.free ?? 0)}</dd>
                </div>
              </dl>
            </section>

            <RulesSection
              rules={init.rules}
              hasWorkspace={Boolean(init.workspace)}
              onSetRule={onSetRule}
              onMoveRule={onMoveRule}
            />

            <McpSection
              mcp={init.mcpStatus}
              hasWorkspace={Boolean(init.workspace)}
              onReload={onReloadMcp}
              onSetServer={onSetMcpServer}
              onToggleServer={onToggleMcpServer}
              onRemoveServer={onRemoveMcpServer}
            />

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
                  <p
                    className={`doctor-summary ${
                      doctor.ok ? (doctorWarns > 0 ? 'is-warn' : 'is-ok') : 'is-bad'
                    }`}
                  >
                    {doctor.ok
                      ? doctorWarns > 0
                        ? `${doctorWarns} check${doctorWarns === 1 ? '' : 's'} you can fix.`
                        : 'Environment is ready.'
                      : `${doctorFails} check${doctorFails === 1 ? '' : 's'} failed${
                          doctorWarns > 0 ? `, ${doctorWarns} to fix` : ''
                        }.`}
                  </p>
                  <ul className="doctor-list">
                    {doctor.checks.map((check) => (
                      <li
                        key={check.label}
                        className={`doctor-row${check.fix?.kind === 'set-key' ? ' is-key' : ''}`}
                      >
                        <span className={`status-dot is-${check.status}`} />
                        <span className="doctor-label">{check.label}</span>
                        <span className="doctor-detail mono" title={check.detail}>
                          {check.detail}
                        </span>
                        {check.fix ? (
                          <span className="doctor-action">
                            <FixControl fix={check.fix} onApply={onApplyFix} />
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="inspect-hint">
                  Check Node, provider keys, config, MCP, sessions, and the code index without
                  calling a model. Every warning comes with the action that clears it.
                </p>
              )}
            </section>
          </div>
        ) : null}

        {tab === 'cost' ? (
          <CostPanel
            key={`${init.cost.model.provider}/${init.cost.model.modelId}`}
            cost={init.cost}
            onSetPricing={onSetPricing}
          />
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
            {/* The instruction is about rows, so it waits for them: with nothing to
                click it would only describe a panel that cannot do what it says. */}
            {files.length > 0 ? (
              <p className="inspect-hint">Click a file to add `@path` to the prompt.</p>
            ) : null}
            <div className="file-list">
              {filesError ? (
                <p className="inspect-warning" role="alert" data-testid="files-error">
                  Cake could not read this folder: {filesError}
                </p>
              ) : filesLoading && files.length === 0 ? (
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
