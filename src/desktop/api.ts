import type { ModelMessage } from 'ai';
import type { CostBoard, WorkspaceSpend } from '../core/cost-board.js';
import type { Pricing, PricingSource } from '../core/pricing.js';
import type { CodebaseHit } from '../rag/retrieval.js';
import type { PermissionPreview, TaskItem } from '../tools/types.js';

/**
 * Wire contract shared by the Electron main process, the preload bridge, and the
 * renderer. Keep this file free of Node imports: the renderer type-checks against it.
 */

export type PermissionModeName = 'plan' | 'default' | 'acceptEdits' | 'yolo';
export type PermissionClass = 'read' | 'write' | 'shell';
export type PermissionDecisionName = 'allow' | 'deny';

export interface ModelHandle {
  provider: string;
  modelId: string;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type RuleScopeName = 'project' | 'global';
export type RuleListName = 'allow' | 'deny';
/** One slot in the list: -1 up, 1 down. */
export type RuleMove = -1 | 1;

/** One rule as the Inspector lists it, tagged with the file that holds it. */
export interface RuleRow {
  rule: string;
  scope: RuleScopeName;
}

export interface RulesPayload {
  /** Workspace rules first, then global, each in the order its file lists them. */
  allow: RuleRow[];
  deny: RuleRow[];
  /** Where each scope's rules are stored; the workspace file is null until one is open. */
  files: Record<RuleScopeName, string | null>;
  /** Rules set in both lists; deny wins, so their allow side never fires. */
  conflicts: string[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  defaultModelId: string;
  maxContext: number;
  hasKey: boolean;
}

/** One configured MCP server, as the Inspector lists it. */
export interface McpServerRow {
  name: string;
  transport: 'stdio' | 'http';
  scope: RuleScopeName;
  enabled: boolean;
  connected: boolean;
  tools: number;
  /** Why it is not live; null while connected or switched off. */
  error: string | null;
  /** The entry as written, so an edit starts from what is really configured. */
  target: { command: string; args: string[] } | { url: string };
  /** The permission class the file pins; null means each tool's own annotation decides. */
  permission: PermissionClass | null;
}

export interface McpStatus {
  /** Names of the servers that connected; the sidebar shows a live count. */
  servers: string[];
  tools: number;
  warnings: string[];
  /** One row per configured server, live or not. */
  rows: McpServerRow[];
  /** Where each scope's servers are declared; null until a workspace is open. */
  files: Record<RuleScopeName, string | null>;
  /** What the last connect changed, empty on the first read. */
  changes: string[];
}

/** What the Inspector can author for one server; the kernel validates on write. */
export type McpDraft =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args: string[];
      permission?: PermissionClass;
      enabled?: boolean;
    }
  | {
      name: string;
      transport: 'http';
      url: string;
      permission?: PermissionClass;
      enabled?: boolean;
    };

export interface WorkspaceInfo {
  cwd: string;
  sessionId: string;
}

/** One priced `provider/model-substring` row, as the Inspector displays it. */
export interface PricingRow {
  pattern: string;
  inputPer1M: number;
  outputPer1M: number;
}

export interface CostPayload {
  /** The model whose rates are shown. */
  model: ModelHandle;
  /** The row that answered for `model`; null when cake has no price for it. */
  effective: PricingRow | null;
  /** Where `effective` came from; null when there is no rate. */
  source: PricingSource | null;
  /** Rows written by config, which win over the built-in card. */
  overrides: PricingRow[];
  /** The shipped reference card. */
  builtin: PricingRow[];
  /** Where editing this workspace's rates writes; null when no workspace is open. */
  configFile: string | null;
  /** Turn, model and nested-work spend of the open session; null when none is open. */
  board: CostBoard | null;
  /** The open session's own totals, which can exceed the board for older sessions. */
  rollup: { costUsd: number; totalTokens: number } | null;
  /** Every session of this workspace added together; null when no workspace is open. */
  workspace: WorkspaceSpend | null;
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  totalTokens: number;
  costUsd: number;
  /** Tokens of this session with no rate; their spend is unknown, not zero. */
  unpricedTokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionPayload {
  session: SessionInfo;
  messages: ModelMessage[];
  /** The checklist the session left off with, so a switch does not lose it. */
  plan: TaskItem[];
}

export type ContextLayerId = 'system' | 'project' | 'retrieved' | 'history' | 'turn';

export interface ContextEntryPayload {
  label: string;
  detail?: string;
  tokens: number;
}

export interface ContextLayerPayload {
  id: ContextLayerId;
  label: string;
  tokens: number;
  entries: ContextEntryPayload[];
}

export interface ContextPayload {
  layers: ContextLayerPayload[];
  maxContext: number;
  used: number;
  free: number;
  /** Layers are measured at ~4 characters per token, not with a real tokenizer. */
  estimated: true;
}

export interface InitPayload {
  version: string;
  workspace: WorkspaceInfo | null;
  /** Recently opened workspaces, most recent first. */
  recents: string[];
  providers: ProviderSummary[];
  model: ModelHandle;
  mode: PermissionModeName;
  rules: RulesPayload;
  mcpStatus: McpStatus;
  missingKeys: string[];
  /** Rate card for the open model, with the config rows that override it. */
  cost: CostPayload;
  /** Checklist of the open session; empty when no workspace is open. */
  plan: TaskItem[];
}

export interface RunResult {
  sessionId: string;
  usage: TokenTotals;
  costUsd: number;
  text: string;
}

export type DoctorCheckStatus = 'ok' | 'warn' | 'fail';

/** A config file a fix can open; only these names cross IPC, never a path. */
export type DoctorFileTargetName =
  | 'config-project'
  | 'config-global'
  | 'mcp-project'
  | 'mcp-global'
  | 'settings-project'
  | 'settings-global';

/** A SQLite file a fix can only reveal in the file manager. */
export type DoctorStoreTargetName = 'sessions' | 'index';

export type DoctorFixPayload =
  | { kind: 'set-key'; provider: string; envVar: string }
  | { kind: 'reindex' }
  | { kind: 'reload-mcp' }
  | { kind: 'open-workspace' }
  | { kind: 'open-file'; target: DoctorFileTargetName }
  | { kind: 'reveal'; target: DoctorStoreTargetName };

export interface DoctorCheckPayload {
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  /** What the app can do about it; absent when the fix lives outside cake. */
  fix?: DoctorFixPayload;
}

export interface DoctorReportPayload {
  checks: DoctorCheckPayload[];
  ok: boolean;
}

export interface PermissionRequestPayload {
  id: string;
  tool: string;
  permission: PermissionClass;
  target: string;
  danger?: string;
  preview?: PermissionPreview;
}

export type AgentNoteKind = 'index' | 'codebase' | 'files' | 'context';

export interface AgentNotePayload {
  kind: AgentNoteKind;
  text: string;
  /** On a codebase note: the chunks that went into the prompt, best first. */
  hits?: CodebaseHit[];
}

/** The complete surface exposed on `window.cake` by the preload script. */
export interface CakeApi {
  init(): Promise<InitPayload>;
  pickWorkspace(): Promise<string | null>;
  openWorkspace(path: string): Promise<InitPayload>;

  listSessions(): Promise<SessionInfo[]>;
  newSession(): Promise<SessionPayload>;
  openSession(id: string): Promise<SessionPayload>;
  renameSession(id: string, title: string): Promise<SessionInfo[]>;
  /** Deletes a session; when it was active, returns the session that becomes active. */
  deleteSession(id: string): Promise<SessionPayload | null>;

  run(sessionId: string, prompt: string): Promise<RunResult>;
  abort(): Promise<void>;
  respondPermission(id: string, decision: PermissionDecisionName): Promise<void>;

  setModel(model: ModelHandle): Promise<InitPayload>;
  setMode(mode: PermissionModeName): Promise<InitPayload>;
  /** Write or remove (with null) this workspace's rate for one `provider/model` pattern. */
  setPricing(pattern: string, rates: Pricing | null): Promise<InitPayload>;
  /** The rate card and spend board of the open session, without a full re-init. */
  getCost(): Promise<CostPayload>;
  /** Add or drop a `tool(pattern)` rule in one scope's allow/deny list. */
  setRule(
    action: 'add' | 'remove',
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
  ): Promise<InitPayload>;
  /** Nudge a rule one slot within its own scope's list. */
  moveRule(
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
    delta: RuleMove,
  ): Promise<InitPayload>;
  reloadMcp(): Promise<InitPayload>;
  /** Write one server entry, replacing the one with the same name in that scope. */
  setMcpServer(scope: RuleScopeName, draft: McpDraft): Promise<InitPayload>;
  removeMcpServer(scope: RuleScopeName, name: string): Promise<InitPayload>;
  /** Switch a configured server off or on; the entry keeps its other fields. */
  setMcpEnabled(scope: RuleScopeName, name: string, enabled: boolean): Promise<InitPayload>;
  listFiles(query: string): Promise<string[]>;
  runDoctor(): Promise<DoctorReportPayload>;
  /** Store a provider key in the global config and reconnect that provider. */
  setProviderKey(provider: string, key: string): Promise<InitPayload>;
  /** Build or refresh the semantic index for the open workspace. */
  rebuildIndex(): Promise<string>;
  /** Open one of cake's own config files, creating it when nothing is there yet. */
  openDoctorFile(target: DoctorFileTargetName): Promise<string>;
  /** Show one of cake's SQLite stores in the file manager. */
  revealDoctorStore(target: DoctorStoreTargetName): Promise<string>;
  /** Composition of the context window, layer by layer, for the Slice. */
  contextLayers(): Promise<ContextPayload>;

  onAgentEvent(handler: (event: unknown) => void): () => void;
  onAgentNote(handler: (note: AgentNotePayload) => void): () => void;
  onPermissionRequest(handler: (request: PermissionRequestPayload) => void): () => void;
  onMcpStatus(handler: (status: McpStatus) => void): () => void;
}
