import { describe, expect, it, vi } from 'vitest';
import type {
  ContextPayload,
  DoctorReportPayload,
  InitPayload,
  RunResult,
  SessionInfo,
  SessionPayload,
} from '../src/desktop/api.js';
import {
  createHandlers,
  type DesktopBackend,
  toWireEvent,
  workspaceOpenSchema,
} from '../src/desktop/ipc.js';

const initPayload: InitPayload = {
  version: '0.1.0',
  workspace: null,
  recents: [],
  providers: [],
  model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  mode: 'default',
  rules: { allow: [], deny: [] },
  mcpStatus: { servers: [], tools: 0, warnings: [] },
  missingKeys: [],
};

const contextPayload: ContextPayload = {
  layers: [
    {
      id: 'system',
      label: 'System',
      tokens: 900,
      entries: [{ label: 'Agent instructions', tokens: 900 }],
    },
    {
      id: 'history',
      label: 'History',
      tokens: 2100,
      entries: [{ label: 'assistant', tokens: 2100 }],
    },
  ],
  maxContext: 128_000,
  used: 3000,
  free: 125_000,
  estimated: true,
};

const session: SessionInfo = {
  id: 'session-1',
  title: '',
  cwd: '/tmp/demo',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  totalTokens: 0,
  costUsd: 0,
  createdAt: 1,
  updatedAt: 1,
};

const sessionPayload: SessionPayload = { session, messages: [] };

const runResult: RunResult = {
  sessionId: 'session-1',
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  costUsd: 0,
  text: 'ok',
};

const doctorReport: DoctorReportPayload = {
  ok: true,
  checks: [{ label: 'Node >= 22.5', status: 'ok', detail: 'v24.0.0' }],
};

function backend(): DesktopBackend {
  return {
    init: vi.fn(async () => initPayload),
    listSessions: vi.fn(() => [session]),
    newSession: vi.fn(() => sessionPayload),
    openSession: vi.fn(() => sessionPayload),
    renameSession: vi.fn(() => [session]),
    deleteSession: vi.fn(() => sessionPayload),
    run: vi.fn(async () => runResult),
    abort: vi.fn(),
    respondPermission: vi.fn(),
    setModel: vi.fn(async () => initPayload),
    setMode: vi.fn(async () => initPayload),
    reloadMcp: vi.fn(async () => initPayload),
    listFiles: vi.fn(async () => ['src/a.ts']),
    runDoctor: vi.fn(async () => doctorReport),
    contextLayers: vi.fn(() => contextPayload),
  };
}

describe('desktop IPC handlers', () => {
  it('delegates init and session channels', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    expect(await handlers['app:init']?.(undefined)).toEqual(initPayload);
    expect(await handlers['session:list']?.(undefined)).toEqual([session]);
    expect(await handlers['session:new']?.(undefined)).toEqual(sessionPayload);
    expect(await handlers['session:open']?.({ id: 'session-1' })).toEqual(sessionPayload);
    expect(fake.openSession).toHaveBeenCalledWith('session-1');
    expect(await handlers['session:rename']?.({ id: 'session-1', title: 'new name' })).toEqual([
      session,
    ]);
    expect(fake.renameSession).toHaveBeenCalledWith('session-1', 'new name');
    expect(await handlers['session:delete']?.({ id: 'session-1' })).toEqual(sessionPayload);
    expect(fake.deleteSession).toHaveBeenCalledWith('session-1');
    expect(await handlers['doctor:run']?.(undefined)).toEqual(doctorReport);
    expect(await handlers['context:layers']?.(undefined)).toEqual(contextPayload);
    expect(fake.runDoctor).toHaveBeenCalledTimes(1);
  });

  it('validates agent:run payloads before touching the backend', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    await expect(handlers['agent:run']?.({ sessionId: 'session-1' })).rejects.toThrow(
      'Invalid prompt',
    );
    await expect(handlers['agent:run']?.({ prompt: 'hi' })).rejects.toThrow('Invalid sessionId');
    await expect(
      handlers['agent:run']?.({ sessionId: 'session-1', prompt: 'hi' }),
    ).resolves.toEqual(runResult);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(fake.run).toHaveBeenCalledWith('session-1', 'hi');
  });

  it('rejects malformed permission, mode, and model payloads', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    await expect(handlers['permission:respond']?.({ id: 'p1', decision: 'maybe' })).rejects.toThrow(
      'Invalid decision',
    );
    await expect(handlers['mode:set']?.({ mode: 'turbo' })).rejects.toThrow('Invalid mode');
    await expect(handlers['model:set']?.({ provider: 'deepseek', modelId: '' })).rejects.toThrow(
      'Invalid modelId',
    );
    await expect(handlers['model:set']?.({ modelId: 'deepseek-chat' })).rejects.toThrow(
      'Invalid provider',
    );

    expect(fake.respondPermission).not.toHaveBeenCalled();
    expect(fake.setMode).not.toHaveBeenCalled();
    expect(fake.setModel).not.toHaveBeenCalled();

    await handlers['model:set']?.({ provider: 'deepseek', modelId: 'deepseek-chat' });
    expect(fake.setModel).toHaveBeenCalledWith({
      provider: 'deepseek',
      modelId: 'deepseek-chat',
    });
  });

  it('defaults the @file query and forwards permission decisions', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    expect(await handlers['files:list']?.(undefined)).toEqual(['src/a.ts']);
    expect(fake.listFiles).toHaveBeenCalledWith('');

    await handlers['permission:respond']?.({ id: 'p7', decision: 'deny' });
    expect(fake.respondPermission).toHaveBeenCalledWith('p7', 'deny');
  });

  it('validates the workspace path schema', () => {
    expect(workspaceOpenSchema.parse({ path: 'D:/work/demo' })).toEqual({ path: 'D:/work/demo' });
    expect(() => workspaceOpenSchema.parse({ path: '' })).toThrow();
    expect(() => workspaceOpenSchema.parse({})).toThrow();
  });
});

describe('wire event serialization', () => {
  it('turns tool errors into plain objects', () => {
    const wire = toWireEvent({
      type: 'tool-error',
      toolName: 'bash',
      error: new Error('denied'),
    }) as { error: { name: string; message: string } };

    expect(wire).toEqual({
      type: 'tool-error',
      toolName: 'bash',
      error: { name: 'Error', message: 'denied' },
    });
  });

  it('turns run errors into plain objects and leaves other events intact', () => {
    expect(toWireEvent({ type: 'error', error: new TypeError('bad') })).toEqual({
      type: 'error',
      error: { name: 'TypeError', message: 'bad' },
    });
    expect(toWireEvent({ type: 'text-delta', delta: 'hi' })).toEqual({
      type: 'text-delta',
      delta: 'hi',
    });
  });
});
