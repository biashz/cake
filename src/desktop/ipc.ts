import { z } from 'zod';
import type { AgentEvent } from '../core/events.js';
import type { Pricing } from '../core/pricing.js';
import type {
  ContextPayload,
  CostPayload,
  DoctorFileTargetName,
  DoctorReportPayload,
  DoctorStoreTargetName,
  InitPayload,
  McpDraft,
  PermissionDecisionName,
  PermissionModeName,
  RuleListName,
  RuleMove,
  RuleScopeName,
  RunResult,
  SessionInfo,
  SessionPayload,
} from './api.js';

/** Main-process surface the IPC layer delegates to; `WorkspaceController` implements it. */
export interface DesktopBackend {
  init(): Promise<InitPayload>;
  listSessions(): SessionInfo[];
  newSession(): SessionPayload;
  openSession(id: string): SessionPayload;
  renameSession(id: string, title: string): SessionInfo[];
  deleteSession(id: string): SessionPayload | null;
  run(sessionId: string, prompt: string): Promise<RunResult>;
  abort(): void;
  respondPermission(id: string, decision: PermissionDecisionName): void;
  setModel(model: { provider: string; modelId: string }): Promise<InitPayload>;
  setMode(mode: PermissionModeName): Promise<InitPayload>;
  setPricing(pattern: string, rates: Pricing | null): Promise<InitPayload>;
  getCost(): Promise<CostPayload>;
  addRule(list: RuleListName, scope: RuleScopeName, rule: string): Promise<InitPayload>;
  removeRule(list: RuleListName, scope: RuleScopeName, rule: string): Promise<InitPayload>;
  moveRule(
    list: RuleListName,
    scope: RuleScopeName,
    rule: string,
    delta: RuleMove,
  ): Promise<InitPayload>;
  reloadMcp(): Promise<InitPayload>;
  setMcpServer(scope: RuleScopeName, draft: McpDraft): Promise<InitPayload>;
  removeMcpServer(scope: RuleScopeName, name: string): Promise<InitPayload>;
  setMcpEnabled(scope: RuleScopeName, name: string, enabled: boolean): Promise<InitPayload>;
  listFiles(query: string): Promise<string[]>;
  runDoctor(): Promise<DoctorReportPayload>;
  setProviderKey(provider: string, key: string): Promise<InitPayload>;
  rebuildIndex(): Promise<string>;
  openDoctorFile(target: DoctorFileTargetName): Promise<string>;
  revealDoctorStore(target: DoctorStoreTargetName): Promise<string>;
  contextLayers(): ContextPayload;
}

export const workspaceOpenSchema = z.object({
  path: z.string().min(1),
});

export function parseWorkspacePath(payload: unknown): string {
  return validate(workspaceOpenSchema, payload).path;
}

const runSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1).max(200_000),
});

const sessionSchema = z.object({
  id: z.string().min(1),
});

const permissionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
});

const renameSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(120),
});

const modelSchema = z.object({
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
});

const modeSchema = z.object({
  mode: z.enum(['plan', 'default', 'acceptEdits', 'yolo']),
});

const filesSchema = z.object({
  query: z.string().max(200).default(''),
});

/** Rates are USD per 1M tokens; a typo should not produce a $1B run. */
const pricingRatesSchema = z.object({
  inputPer1M: z.number().finite().nonnegative().max(100_000),
  outputPer1M: z.number().finite().nonnegative().max(100_000),
});

const pricingSchema = z.object({
  pattern: z.string().min(1).max(200),
  rates: pricingRatesSchema.nullable(),
});

/** Rule syntax is checked by the kernel, which can name the shape it wants. */
const ruleSchema = z.object({
  action: z.enum(['add', 'remove']),
  list: z.enum(['allow', 'deny']),
  scope: z.enum(['project', 'global']),
  rule: z.string().min(1).max(200),
});

const ruleMoveSchema = z.object({
  list: z.enum(['allow', 'deny']),
  scope: z.enum(['project', 'global']),
  rule: z.string().min(1).max(200),
  delta: z.union([z.literal(-1), z.literal(1)]),
});

const mcpScopeSchema = z.enum(['project', 'global']);

/** The entry itself is validated by the kernel writer, which can name the field. */
const mcpServerSchema = z.object({
  scope: mcpScopeSchema,
  draft: z.record(z.string(), z.unknown()),
});

const mcpNameSchema = z.object({
  scope: mcpScopeSchema,
  name: z.string().min(1).max(64),
});

const mcpEnabledSchema = z.object({
  scope: mcpScopeSchema,
  name: z.string().min(1).max(64),
  enabled: z.boolean(),
});

/** Only these names cross IPC, so a fix can never ask for an arbitrary path. */
const doctorFileTargetSchema = z.enum([
  'config-project',
  'config-global',
  'mcp-project',
  'mcp-global',
  'settings-project',
  'settings-global',
]);

const doctorStoreTargetSchema = z.enum(['sessions', 'index']);

const providerKeySchema = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().min(1).max(4096),
});

function validate<T>(schema: z.ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') || 'payload';
    throw new Error(`Invalid ${where}: ${issue?.message ?? 'schema mismatch'}`);
  }
  return result.data;
}

type Handler = (payload: unknown) => Promise<unknown>;

/** Channel → handler map installed by the main process; exported for unit tests. */
export function createHandlers(backend: DesktopBackend): Record<string, Handler> {
  return {
    'app:init': async () => backend.init(),
    'session:list': async () => backend.listSessions(),
    'session:new': async () => backend.newSession(),
    'session:open': async (payload) => backend.openSession(validate(sessionSchema, payload).id),
    'session:rename': async (payload) => {
      const { id, title } = validate(renameSchema, payload);
      return backend.renameSession(id, title);
    },
    'session:delete': async (payload) => backend.deleteSession(validate(sessionSchema, payload).id),
    'agent:run': async (payload) => {
      const { sessionId, prompt } = validate(runSchema, payload);
      return backend.run(sessionId, prompt);
    },
    'agent:abort': async () => backend.abort(),
    'permission:respond': async (payload) => {
      const { id, decision } = validate(permissionSchema, payload);
      backend.respondPermission(id, decision);
    },
    'model:set': async (payload) => backend.setModel(validate(modelSchema, payload)),
    'mode:set': async (payload) => backend.setMode(validate(modeSchema, payload).mode),
    'pricing:set': async (payload) => {
      const { pattern, rates } = validate(pricingSchema, payload);
      return backend.setPricing(pattern, rates);
    },
    'cost:get': async () => backend.getCost(),
    'mcp:reload': async () => backend.reloadMcp(),
    'mcp:set': async (payload) => {
      const { scope, draft } = validate(mcpServerSchema, payload);
      return backend.setMcpServer(scope, draft as McpDraft);
    },
    'mcp:remove': async (payload) => {
      const { scope, name } = validate(mcpNameSchema, payload);
      return backend.removeMcpServer(scope, name);
    },
    'mcp:enabled': async (payload) => {
      const { scope, name, enabled } = validate(mcpEnabledSchema, payload);
      return backend.setMcpEnabled(scope, name, enabled);
    },
    'rules:set': async (payload) => {
      const { action, list, scope, rule } = validate(ruleSchema, payload);
      return action === 'add'
        ? backend.addRule(list, scope, rule)
        : backend.removeRule(list, scope, rule);
    },
    'rules:move': async (payload) => {
      const { list, scope, rule, delta } = validate(ruleMoveSchema, payload);
      return backend.moveRule(list, scope, rule, delta);
    },
    'files:list': async (payload) => backend.listFiles(validate(filesSchema, payload ?? {}).query),
    'doctor:run': async () => backend.runDoctor(),
    'doctor:key': async (payload) => {
      const { provider, key } = validate(providerKeySchema, payload);
      return backend.setProviderKey(provider, key);
    },
    'doctor:reindex': async () => backend.rebuildIndex(),
    'doctor:open': async (payload) =>
      backend.openDoctorFile(validate(doctorFileTargetSchema, payload)),
    'doctor:reveal': async (payload) =>
      backend.revealDoctorStore(validate(doctorStoreTargetSchema, payload)),
    'context:layers': async () => backend.contextLayers(),
  };
}

/** Errors are not reliably structured-clonable across every Electron version. */
export function toWireEvent(event: AgentEvent): unknown {
  if (event.type === 'tool-error') {
    return {
      type: 'tool-error',
      callId: event.callId,
      ...(event.agentCallId === undefined ? {} : { agentCallId: event.agentCallId }),
      toolName: event.toolName,
      error: { name: event.error.name, message: event.error.message },
    };
  }
  if (event.type === 'error') {
    return { type: 'error', error: { name: event.error.name, message: event.error.message } };
  }
  return event;
}
