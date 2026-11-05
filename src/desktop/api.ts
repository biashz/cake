import type { ModelMessage } from 'ai';

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

export interface PermissionRuleSet {
  allow: string[];
  deny: string[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  defaultModelId: string;
  maxContext: number;
  hasKey: boolean;
}

export interface McpStatus {
  servers: string[];
  tools: number;
  warnings: string[];
}

export interface WorkspaceInfo {
  cwd: string;
  sessionId: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionPayload {
  session: SessionInfo;
  messages: ModelMessage[];
}

export interface InitPayload {
  version: string;
  workspace: WorkspaceInfo | null;
  providers: ProviderSummary[];
  model: ModelHandle;
  mode: PermissionModeName;
  rules: PermissionRuleSet;
  mcpStatus: McpStatus;
  missingKeys: string[];
}

export interface RunResult {
  sessionId: string;
  usage: TokenTotals;
  costUsd: number;
  text: string;
}

export type DoctorCheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheckPayload {
  label: string;
  status: DoctorCheckStatus;
  detail: string;
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
}

export type AgentNoteKind = 'index' | 'codebase' | 'files' | 'context';

export interface AgentNotePayload {
  kind: AgentNoteKind;
  text: string;
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
  reloadMcp(): Promise<InitPayload>;
  listFiles(query: string): Promise<string[]>;
  runDoctor(): Promise<DoctorReportPayload>;

  onAgentEvent(handler: (event: unknown) => void): () => void;
  onAgentNote(handler: (note: AgentNotePayload) => void): () => void;
  onPermissionRequest(handler: (request: PermissionRequestPayload) => void): () => void;
  onMcpStatus(handler: (status: McpStatus) => void): () => void;
}
