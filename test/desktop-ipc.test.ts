import { describe, expect, it, vi } from 'vitest';
import { buildCostBoard, type CostRow } from '../src/core/cost-board.js';
import { MAX_IMAGE_BYTES, MAX_IMAGE_URL_CHARS, MAX_IMAGES_PER_TURN } from '../src/core/images.js';
import type {
  ContextPayload,
  CostPayload,
  DoctorFileTargetName,
  DoctorReportPayload,
  DoctorStoreTargetName,
  InitPayload,
  McpStatus,
  RevertResult,
  RulesPayload,
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
import type { ExportResult } from '../src/session/export.js';

function row(overrides: Partial<CostRow> = {}): CostRow {
  return {
    turn: 1,
    seq: 0,
    occurredAt: 1_700_000_000_000,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    scope: 'main',
    agentType: '',
    inputTokens: 1_000,
    outputTokens: 200,
    totalTokens: 1_200,
    costUsd: 0.0123,
    priced: true,
    ...overrides,
  };
}

const costPayload: CostPayload = {
  model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  effective: { pattern: 'anthropic/sonnet', inputPer1M: 3, outputPer1M: 15 },
  source: 'builtin',
  overrides: [{ pattern: 'deepseek/deepseek-chat', inputPer1M: 0.2, outputPer1M: 0.27 }],
  builtin: [{ pattern: 'anthropic/sonnet', inputPer1M: 3, outputPer1M: 15 }],
  configFile: '/tmp/demo/.cake/config.json',
  board: buildCostBoard([row(), row({ turn: 2, costUsd: 0.02, priced: false })]),
  rollup: { costUsd: 0.0323, totalTokens: 2_400 },
  workspace: { sessions: 3, costUsd: 0.4, totalTokens: 30_000, unpricedTokens: 1_200 },
};

const rulesPayload: RulesPayload = {
  allow: [{ rule: 'read', scope: 'global' }],
  deny: [
    { rule: 'bash(rm *)', scope: 'project' },
    { rule: 'edit(.git/*)', scope: 'project' },
  ],
  files: { global: '/home/u/.cake/settings.json', project: '/tmp/demo/.cake/settings.json' },
  conflicts: [],
};

const mcpStatusPayload: McpStatus = {
  servers: ['files'],
  tools: 2,
  warnings: [],
  rows: [
    {
      name: 'files',
      transport: 'stdio',
      scope: 'project',
      enabled: true,
      connected: true,
      tools: 2,
      error: null,
      target: { command: 'npx', args: ['-y', 'server.js'] },
      permission: null,
    },
  ],
  files: { global: '/home/u/.cake/mcp.json', project: '/tmp/demo/.cake/mcp.json' },
  changes: ['files added — online with 2 tools'],
};

const initPayload: InitPayload = {
  version: '0.1.0',
  workspace: null,
  recents: [],
  providers: [],
  model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  attachments: { vision: true, perTurn: MAX_IMAGES_PER_TURN, maxBytes: MAX_IMAGE_BYTES },
  mode: 'default',
  rules: rulesPayload,
  mcpStatus: mcpStatusPayload,
  missingKeys: [],
  cost: costPayload,
  plan: [],
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
  unpricedTokens: 0,
  createdAt: 1,
  updatedAt: 1,
};

const sessionPayload: SessionPayload = { session, messages: [], plan: [] };

/** An export with no pictures: one file, and nothing beside it to open. */
const exportResult: ExportResult = {
  file: '/tmp/demo/.cake/exports/demo-session1.md',
  pictures: 0,
};

const revertResult: RevertResult = {
  checkpointId: '0000000000001-abcd1234',
  applied: true,
  changes: [{ path: 'a.ts', action: 'restored' }],
  overwrittenBy: [],
};

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
    forkSession: vi.fn(() => sessionPayload),
    exportSession: vi.fn(() => exportResult),
    checkpointTurns: vi.fn(async () => []),
    revertCheckpoint: vi.fn(async () => revertResult),
    run: vi.fn(async () => runResult),
    abort: vi.fn(),
    respondPermission: vi.fn(),
    setModel: vi.fn(async () => initPayload),
    setMode: vi.fn(async () => initPayload),
    setPricing: vi.fn(async () => initPayload),
    getCost: vi.fn(async () => costPayload),
    addRule: vi.fn(async () => initPayload),
    removeRule: vi.fn(async () => initPayload),
    moveRule: vi.fn(async () => initPayload),
    reloadMcp: vi.fn(async () => initPayload),
    setMcpServer: vi.fn(async () => initPayload),
    removeMcpServer: vi.fn(async () => initPayload),
    setMcpEnabled: vi.fn(async () => initPayload),
    listFiles: vi.fn(async () => ['src/a.ts']),
    runDoctor: vi.fn(async () => doctorReport),
    setProviderKey: vi.fn(async () => initPayload),
    rebuildIndex: vi.fn(async () => 'Indexed 12 chunks from 3 files.'),
    openDoctorFile: vi.fn(async (target: DoctorFileTargetName) => `opened:${target}`),
    revealDoctorStore: vi.fn(async (target: DoctorStoreTargetName) => `revealed:${target}`),
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
    expect(await handlers['session:fork']?.({ id: 'session-1' })).toEqual(sessionPayload);
    expect(fake.forkSession).toHaveBeenCalledWith('session-1');
    expect(await handlers['session:export']?.({ id: 'session-1' })).toEqual(exportResult);
    expect(fake.exportSession).toHaveBeenCalledWith('session-1', undefined);
    expect(await handlers['session:export']?.({ id: 'session-1', file: 'notes.md' })).toEqual(
      exportResult,
    );
    expect(fake.exportSession).toHaveBeenCalledWith('session-1', 'notes.md');
    expect(await handlers['doctor:run']?.(undefined)).toEqual(doctorReport);
    expect(await handlers['context:layers']?.(undefined)).toEqual(contextPayload);
    expect(fake.runDoctor).toHaveBeenCalledTimes(1);
  });

  it('refuses an export request that is not a session and a plain name', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    for (const payload of [
      { id: 'session-1', file: '' },
      { id: 'session-1', file: 42 },
      { id: '', file: 'notes.md' },
      { file: 'notes.md' },
      undefined,
    ]) {
      await expect(handlers['session:export']?.(payload)).rejects.toThrow(/Invalid/);
    }
    expect(fake.exportSession).not.toHaveBeenCalled();
  });

  it('carries an undo request to the controller, force and all', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    expect(await handlers['checkpoint:turns']?.({ sessionId: 'session-1' })).toEqual([]);
    expect(fake.checkpointTurns).toHaveBeenCalledWith('session-1');
    expect(
      await handlers['checkpoint:revert']?.({ checkpointId: revertResult.checkpointId }),
    ).toEqual(revertResult);
    expect(fake.revertCheckpoint).toHaveBeenCalledWith(revertResult.checkpointId, undefined);
    await handlers['checkpoint:revert']?.({ checkpointId: revertResult.checkpointId, force: true });
    expect(fake.revertCheckpoint).toHaveBeenLastCalledWith(revertResult.checkpointId, true);
  });

  it('refuses an undo request that names no archive', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    for (const payload of [{}, { checkpointId: '' }, { sessionId: 'session-1' }]) {
      await expect(handlers['checkpoint:revert']?.(payload)).rejects.toThrow(/Invalid/);
    }
    expect(fake.revertCheckpoint).not.toHaveBeenCalled();
    await expect(handlers['checkpoint:turns']?.({})).rejects.toThrow(/Invalid/);
    expect(fake.checkpointTurns).not.toHaveBeenCalled();
  });

  it('accepts every declared doctor file target', async () => {
    const handlers = createHandlers(backend());
    const targets: DoctorFileTargetName[] = [
      'config-project',
      'config-global',
      'mcp-project',
      'mcp-global',
      'settings-project',
      'settings-global',
    ];
    for (const target of targets) {
      expect(await handlers['doctor:open']?.(target)).toBe(`opened:${target}`);
    }
    const stores: DoctorStoreTargetName[] = ['sessions', 'index'];
    for (const target of stores) {
      expect(await handlers['doctor:reveal']?.(target)).toBe(`revealed:${target}`);
    }
  });

  it('refuses a doctor file target that is not one of the named configs', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    for (const payload of ['../../etc/passwd', 'config-project/../../x', undefined, 42]) {
      await expect(handlers['doctor:open']?.(payload)).rejects.toThrow(/Invalid payload/);
    }
    await expect(handlers['doctor:reveal']?.('sessions.db')).rejects.toThrow(/Invalid payload/);
    expect(fake.openDoctorFile).not.toHaveBeenCalled();
    expect(fake.revealDoctorStore).not.toHaveBeenCalled();
  });

  it('stores a provider key through the backend and rejects an empty one', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    expect(await handlers['doctor:key']?.({ provider: 'anthropic', key: 'sk-ant-1' })).toEqual(
      initPayload,
    );
    expect(fake.setProviderKey).toHaveBeenCalledWith('anthropic', 'sk-ant-1');
    await expect(handlers['doctor:key']?.({ provider: 'anthropic', key: '' })).rejects.toThrow(
      'Invalid key',
    );
    await expect(handlers['doctor:key']?.({ provider: '', key: 'x' })).rejects.toThrow(
      'Invalid provider',
    );
    expect(fake.setProviderKey).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the index on request', async () => {
    const fake = backend();
    expect(await createHandlers(fake)['doctor:reindex']?.(undefined)).toContain('Indexed');
    expect(fake.rebuildIndex).toHaveBeenCalledTimes(1);
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
    expect(fake.run).toHaveBeenCalledWith('session-1', 'hi', []);
  });

  it('keeps an attachments list inside the caps a turn can carry', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);
    const png = 'data:image/png;base64,AAA=';

    await expect(
      handlers['agent:run']?.({
        sessionId: 'session-1',
        prompt: 'hi',
        images: Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, () => png),
      }),
    ).rejects.toThrow(/Invalid images/);
    await expect(
      handlers['agent:run']?.({
        sessionId: 'session-1',
        prompt: 'hi',
        images: ['x'.repeat(MAX_IMAGE_URL_CHARS + 1)],
      }),
    ).rejects.toThrow(/Invalid images/);
    expect(fake.run).not.toHaveBeenCalled();

    // What survives the wire is the kernel's business, so it travels unchanged.
    await handlers['agent:run']?.({ sessionId: 'session-1', prompt: 'hi', images: [png] });
    expect(fake.run).toHaveBeenCalledWith('session-1', 'hi', [png]);
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

  it('writes and removes rates through the pricing channel', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    await expect(
      handlers['pricing:set']?.({ pattern: '', rates: { inputPer1M: 1, outputPer1M: 2 } }),
    ).rejects.toThrow('Invalid pattern');
    await expect(
      handlers['pricing:set']?.({
        pattern: 'anthropic/sonnet',
        rates: { inputPer1M: -1, outputPer1M: 2 },
      }),
    ).rejects.toThrow('Invalid rates.inputPer1M');
    await expect(
      handlers['pricing:set']?.({
        pattern: 'anthropic/sonnet',
        rates: { inputPer1M: Number.MAX_VALUE, outputPer1M: 2 },
      }),
    ).rejects.toThrow('Invalid rates.inputPer1M');
    expect(fake.setPricing).not.toHaveBeenCalled();

    expect(
      await handlers['pricing:set']?.({
        pattern: 'anthropic/opus',
        rates: { inputPer1M: 15, outputPer1M: 60 },
      }),
    ).toEqual(initPayload);
    expect(fake.setPricing).toHaveBeenCalledWith('anthropic/opus', {
      inputPer1M: 15,
      outputPer1M: 60,
    });

    await handlers['pricing:set']?.({ pattern: 'deepseek/', rates: null });
    expect(fake.setPricing).toHaveBeenLastCalledWith('deepseek/', null);
  });

  it('reads the whole cost board from one channel', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    const payload = (await handlers['cost:get']?.(undefined)) as CostPayload | undefined;
    expect(payload).toEqual(costPayload);
    expect(fake.getCost).toHaveBeenCalledTimes(1);
    expect(payload?.board?.turns.map((turn) => turn.turn)).toEqual([2, 1]);
    expect(payload?.board?.totals.unpricedTokens).toBe(1_200);
    expect(payload?.workspace?.sessions).toBe(3);
  });

  it('adds, removes and moves rules through the rules channels', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    await expect(
      handlers['rules:set']?.({ action: 'add', list: 'allow', scope: 'project', rule: '' }),
    ).rejects.toThrow('Invalid rule');
    await expect(
      handlers['rules:set']?.({ action: 'add', list: 'maybe', scope: 'project', rule: 'read' }),
    ).rejects.toThrow('Invalid list');
    await expect(
      handlers['rules:move']?.({ list: 'allow', scope: 'nowhere', rule: 'read', delta: 1 }),
    ).rejects.toThrow('Invalid scope');
    await expect(
      handlers['rules:move']?.({ list: 'allow', scope: 'project', rule: 'read', delta: 2 }),
    ).rejects.toThrow('Invalid delta');
    expect(fake.addRule).not.toHaveBeenCalled();
    expect(fake.moveRule).not.toHaveBeenCalled();

    expect(
      await handlers['rules:set']?.({
        action: 'add',
        list: 'deny',
        scope: 'global',
        rule: 'bash(rm *)',
      }),
    ).toEqual(initPayload);
    expect(fake.addRule).toHaveBeenCalledWith('deny', 'global', 'bash(rm *)');

    await handlers['rules:set']?.({
      action: 'remove',
      list: 'allow',
      scope: 'project',
      rule: 'read',
    });
    expect(fake.removeRule).toHaveBeenCalledWith('allow', 'project', 'read');

    await handlers['rules:move']?.({
      list: 'deny',
      scope: 'project',
      rule: 'bash(rm *)',
      delta: -1,
    });
    expect(fake.moveRule).toHaveBeenCalledWith('deny', 'project', 'bash(rm *)', -1);
  });

  it('writes, toggles and removes MCP servers through the mcp channels', async () => {
    const fake = backend();
    const handlers = createHandlers(fake);

    await expect(handlers['mcp:set']?.({ scope: 'project' })).rejects.toThrow('Invalid draft');
    await expect(
      handlers['mcp:set']?.({ scope: 'nowhere', draft: { name: 'files', command: 'npx' } }),
    ).rejects.toThrow('Invalid scope');
    await expect(handlers['mcp:remove']?.({ scope: 'project', name: '' })).rejects.toThrow(
      'Invalid name',
    );
    await expect(
      handlers['mcp:enabled']?.({ scope: 'project', name: 'files', enabled: 'yes' }),
    ).rejects.toThrow('Invalid enabled');
    expect(fake.setMcpServer).not.toHaveBeenCalled();
    expect(fake.removeMcpServer).not.toHaveBeenCalled();
    expect(fake.setMcpEnabled).not.toHaveBeenCalled();

    const draft = {
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server.js'],
    };
    expect(await handlers['mcp:set']?.({ scope: 'project', draft })).toEqual(initPayload);
    expect(fake.setMcpServer).toHaveBeenCalledWith('project', draft);

    expect(
      await handlers['mcp:enabled']?.({ scope: 'global', name: 'files', enabled: false }),
    ).toEqual(initPayload);
    expect(fake.setMcpEnabled).toHaveBeenCalledWith('global', 'files', false);

    await handlers['mcp:remove']?.({ scope: 'project', name: 'files' });
    expect(fake.removeMcpServer).toHaveBeenCalledWith('project', 'files');
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
      callId: 'call-9',
      toolName: 'bash',
      error: new Error('denied'),
    }) as { error: { name: string; message: string } };

    expect(wire).toEqual({
      type: 'tool-error',
      callId: 'call-9',
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

  it('carries a plan snapshot across intact', () => {
    expect(
      toWireEvent({
        type: 'plan',
        tasks: [{ id: 1, subject: 'read code', status: 'in_progress' }],
      }),
    ).toEqual({
      type: 'plan',
      tasks: [{ id: 1, subject: 'read code', status: 'in_progress' }],
    });
  });
});
