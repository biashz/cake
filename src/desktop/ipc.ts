import { z } from 'zod';
import type { AgentEvent } from '../core/events.js';
import type {
  DoctorReportPayload,
  InitPayload,
  PermissionDecisionName,
  PermissionModeName,
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
  reloadMcp(): Promise<InitPayload>;
  listFiles(query: string): Promise<string[]>;
  runDoctor(): Promise<DoctorReportPayload>;
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
    'mcp:reload': async () => backend.reloadMcp(),
    'files:list': async (payload) => backend.listFiles(validate(filesSchema, payload ?? {}).query),
    'doctor:run': async () => backend.runDoctor(),
  };
}

/** Errors are not reliably structured-clonable across every Electron version. */
export function toWireEvent(event: AgentEvent): unknown {
  if (event.type === 'tool-error') {
    return {
      type: 'tool-error',
      toolName: event.toolName,
      error: { name: event.error.name, message: event.error.message },
    };
  }
  if (event.type === 'error') {
    return { type: 'error', error: { name: event.error.name, message: event.error.message } };
  }
  return event;
}
