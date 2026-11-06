import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CostLine } from '../src/core/cost.js';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from '../src/core/images.js';
import { WorkspaceController } from '../src/desktop/controller.js';
import { defaultSessionFile, SessionStore } from '../src/session/store.js';

interface Opened {
  paths: string[];
  revealed: string[];
}

/** Deterministic fake vectors so the controller test never calls a real endpoint. */
function embeddingMock() {
  const batches: number[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      const body = JSON.parse(raw) as { input?: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input)];
      batches.push(inputs.length);
      const data = inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: Array.from(
          { length: 8 },
          (_, slot) => (text.charCodeAt(slot % text.length) + slot) / 100,
        ),
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', model: 'text-embedding-3-small', data }));
    });
  });
  return new Promise<{ url: string; batches: number[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        batches,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `cake-controller-${label}-`));
}

function controller(homeDir: string, opened: Opened) {
  return new WorkspaceController({
    stateFile: join(homeDir, 'state.json'),
    send: () => {},
    env: {},
    homeDir,
    openFile: async (file) => {
      opened.paths.push(file);
      return '';
    },
    revealFile: (file) => {
      opened.revealed.push(file);
    },
  });
}

const homes: string[] = [];

function scenario(label: string) {
  const home = tempDir(`${label}-home`);
  const cwd = tempDir(`${label}-cwd`);
  homes.push(home, cwd);
  const opened: Opened = { paths: [], revealed: [] };
  return { home, cwd, opened, ctrl: controller(home, opened) };
}

afterEach(async () => {
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceController doctor fixes', () => {
  it('stores a key in the global config and reports the provider as ready', async () => {
    const { home, cwd, ctrl } = scenario('key');
    const before = await ctrl.openWorkspace(cwd);
    expect(before.missingKeys).toContain('anthropic');

    const init = await ctrl.setProviderKey('anthropic', '  sk-ant-test  ');
    expect(init.missingKeys).not.toContain('anthropic');
    expect(JSON.parse(readFileSync(join(home, '.cake', 'config.json'), 'utf8'))).toEqual({
      providers: { anthropic: { apiKey: 'sk-ant-test' } },
    });

    const doctor = await ctrl.runDoctor();
    expect(doctor.checks.find((check) => check.label === 'anthropic API key')?.status).toBe('ok');
    await ctrl.dispose();
  });

  it('refuses an unknown provider before writing anything', async () => {
    const { home, cwd, ctrl } = scenario('bad-provider');
    await ctrl.openWorkspace(cwd);
    await expect(ctrl.setProviderKey('gemini', 'x')).rejects.toThrow(/Unknown provider/);
    expect(existsSync(join(home, '.cake', 'config.json'))).toBe(false);
    await ctrl.dispose();
  });

  it('creates then opens the config a fix points at', async () => {
    const { cwd, opened, ctrl } = scenario('open');
    await ctrl.openWorkspace(cwd);

    const file = await ctrl.openDoctorFile('mcp-project');
    expect(file).toBe(join(cwd, '.cake', 'mcp.json'));
    expect(opened.paths).toEqual([file]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ mcpServers: {} });
    await ctrl.dispose();
  });

  it('surfaces the platform refusing to open a file', async () => {
    const home = tempDir('open-fail-home');
    const cwd = tempDir('open-fail-cwd');
    homes.push(home, cwd);
    const failing = new WorkspaceController({
      stateFile: join(home, 'state.json'),
      send: () => {},
      env: {},
      homeDir: home,
      openFile: async () => 'No application knows how to open this',
      revealFile: () => {},
    });
    await failing.openWorkspace(cwd);
    await expect(failing.openDoctorFile('settings-project')).rejects.toThrow(
      /No application knows how to open this/,
    );
    await failing.dispose();
  });

  it('reveals the session store instead of trying to edit it', async () => {
    const { cwd, opened, ctrl } = scenario('reveal');
    await ctrl.openWorkspace(cwd);
    const file = await ctrl.revealDoctorStore('sessions');
    expect(file).toBe(join(cwd, '.cake', 'sessions', 'cake.db'));
    expect(opened.revealed).toEqual([file]);
    await ctrl.dispose();
  });

  it('names the missing key rather than pretending it can index', async () => {
    const { cwd, ctrl } = scenario('index');
    await ctrl.openWorkspace(cwd);
    await expect(ctrl.rebuildIndex()).rejects.toThrow(/needs embeddings/);

    const doctor = await ctrl.runDoctor();
    const index = doctor.checks.find((check) => check.label === 'code index');
    expect(index?.fix).toEqual({ kind: 'set-key', provider: 'openai', envVar: 'OPENAI_API_KEY' });
    await ctrl.dispose();
  });

  it('warns with "open a workspace" while nothing is open', async () => {
    const { ctrl } = scenario('no-workspace');
    const doctor = await ctrl.runDoctor();
    const index = doctor.checks.find((check) => check.label === 'code index');
    expect(index?.fix).toEqual({ kind: 'open-workspace' });
    await expect(ctrl.rebuildIndex()).rejects.toThrow(/No workspace is open/);
  });

  it('reloads MCP after a server file is edited by hand', async () => {
    const { cwd, ctrl } = scenario('reload');
    await ctrl.openWorkspace(cwd);
    mkdirSync(join(cwd, '.cake'), { recursive: true });
    writeFileSync(
      join(cwd, '.cake', 'mcp.json'),
      JSON.stringify({
        mcpServers: { docs: { command: 'node', args: ['-e', 'process.exit(1)'] } },
      }),
      'utf8',
    );

    const init = await ctrl.reloadMcp();
    expect(init.mcpStatus.rows.map((row) => row.name)).toContain('docs');
    const doctor = await ctrl.runDoctor();
    expect(doctor.checks.find((check) => check.label === 'MCP servers')?.fix).toEqual({
      kind: 'reload-mcp',
    });
    await ctrl.dispose();
  });

  it('builds the index the doctor then reads', async () => {
    const mock = await embeddingMock();
    const home = tempDir('index-home');
    const cwd = tempDir('index-cwd');
    homes.push(home, cwd);
    writeFileSync(join(cwd, 'answer.ts'), 'export const answer = 42;\nconsole.log(answer);\n');

    const notes: string[] = [];
    const ctrl = new WorkspaceController({
      stateFile: join(home, 'state.json'),
      send: (channel, payload) => {
        if (channel === 'agent:note') {
          const note = payload as { text?: string };
          if (typeof note.text === 'string') notes.push(note.text);
        }
      },
      env: { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: mock.url },
      homeDir: home,
    });

    try {
      await ctrl.openWorkspace(cwd);
      const summary = await ctrl.rebuildIndex();
      expect(summary).toMatch(/Indexed [1-9]\d* chunks from 1 files/);
      expect(mock.batches.length).toBeGreaterThan(0);
      expect(notes.length).toBeGreaterThan(0);
      expect(existsSync(join(cwd, '.cake', 'index', 'code.db'))).toBe(true);

      const doctor = await ctrl.runDoctor();
      const index = doctor.checks.find((check) => check.label === 'code index');
      expect(index?.status).toBe('ok');
      expect(index?.detail).toContain('1 files');
    } finally {
      await ctrl.dispose();
      await mock.close();
    }
  });
});

describe('WorkspaceController cost board', () => {
  const line = (over: Partial<CostLine> = {}): CostLine => ({
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    scope: 'main',
    usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 },
    costUsd: 0.0033,
    priced: true,
    ...over,
  });

  const nested = (over: Partial<CostLine> = {}): CostLine =>
    line({
      scope: 'subagent',
      agentType: 'Explore',
      model: { provider: 'deepseek', modelId: 'deepseek-chat' },
      usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
      costUsd: 0,
      priced: false,
      ...over,
    });

  it('bills the open session by turn and totals the workspace over every session', async () => {
    const { cwd, ctrl } = scenario('cost');
    const before = await ctrl.openWorkspace(cwd);
    const sessionId = before.workspace?.sessionId;
    if (!sessionId) throw new Error('opening a workspace did not give a session');

    // A session that has not run yet is empty, not free.
    expect(before.cost.board?.totals.turns).toBe(0);
    expect(before.cost.board?.work).toEqual([]);
    expect(before.cost.rollup).toEqual({ costUsd: 0, totalTokens: 0 });

    const store = SessionStore.open(defaultSessionFile(cwd));
    store.addTurnUsage(sessionId, [line()]);
    store.addTurnUsage(sessionId, [
      line({ costUsd: 0.0011, usage: { inputTokens: 300, outputTokens: 60, totalTokens: 360 } }),
      nested(),
    ]);
    const other = store.create({ cwd, provider: 'anthropic', model: 'claude-sonnet-4-5' });
    store.addTurnUsage(other.id, [
      line({ costUsd: 0.5, usage: { inputTokens: 40_000, outputTokens: 0, totalTokens: 40_000 } }),
    ]);
    store.close();

    // Re-open so the controller reads its session record back from the store.
    ctrl.openSession(sessionId);
    const cost = await ctrl.getCost();

    expect(cost.board?.turns.map((turn) => turn.turn)).toEqual([2, 1]);
    expect(cost.board?.totals.totalTokens).toBe(2_160);
    expect(cost.board?.totals.costUsd).toBeCloseTo(0.0044, 10);
    expect(cost.board?.work.map((group) => group.key)).toEqual(['main', 'subagent:Explore']);
    expect(cost.board?.work[1]?.unpricedTokens).toBe(600);
    expect(cost.rollup?.totalTokens).toBe(2_160);
    expect(cost.rollup?.costUsd).toBeCloseTo(0.0044, 10);

    const workspace = cost.workspace;
    expect(workspace?.sessions).toBe(2);
    expect(workspace?.totalTokens).toBe(42_160);
    expect(workspace?.costUsd).toBeCloseTo(0.5044, 10);
    expect(workspace?.unpricedTokens).toBe(600);
    await ctrl.dispose();
  });

  it('reports no board, roll-up, or workspace while nothing is open', async () => {
    const { ctrl } = scenario('cost-idle');
    const init = await ctrl.init();

    expect(init.cost.board).toBeNull();
    expect(init.cost.rollup).toBeNull();
    expect(init.cost.workspace).toBeNull();
    await ctrl.dispose();
  });
});

describe('WorkspaceController fork and export', () => {
  it('switches to the branch and leaves the parent untouched', async () => {
    const { cwd, ctrl } = scenario('fork');
    const before = await ctrl.openWorkspace(cwd);
    const sessionId = before.workspace?.sessionId;
    if (!sessionId) throw new Error('opening a workspace did not give a session');

    const store = SessionStore.open(defaultSessionFile(cwd));
    store.saveMessages(sessionId, [{ role: 'user', content: 'the original prompt' }]);
    store.savePlan(sessionId, [{ id: 1, subject: 'keep this step', status: 'in_progress' }]);
    store.close();

    const forked = ctrl.forkSession(sessionId);
    expect(forked.session.id).not.toBe(sessionId);
    expect(forked.session.parentId).toBe(sessionId);
    expect(forked.messages).toEqual([{ role: 'user', content: 'the original prompt' }]);
    expect(forked.plan).toEqual([{ id: 1, subject: 'keep this step', status: 'in_progress' }]);

    const ids = ctrl.listSessions().map((session) => session.id);
    expect(ids).toContain(forked.session.id);
    expect(ctrl.openSession(sessionId).session.parentId).toBeNull();
    await ctrl.dispose();
  });

  it('refuses to fork a session that is not there', async () => {
    const { cwd, ctrl } = scenario('fork-missing');
    await ctrl.openWorkspace(cwd);
    expect(() => ctrl.forkSession('nope')).toThrow(/Unknown session "nope"/);
    await ctrl.dispose();
  });

  it('writes the transcript of a session inside the workspace', async () => {
    const { cwd, ctrl } = scenario('export');
    const before = await ctrl.openWorkspace(cwd);
    const sessionId = before.workspace?.sessionId;
    if (!sessionId) throw new Error('opening a workspace did not give a session');

    const store = SessionStore.open(defaultSessionFile(cwd));
    store.setTitleIfEmpty(sessionId, 'export me');
    store.saveMessages(sessionId, [{ role: 'user', content: 'export me' }]);
    store.close();

    const file = ctrl.exportSession(sessionId).file;
    expect(file.startsWith(join(cwd, '.cake', 'exports'))).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('# export me');
    await ctrl.dispose();
  });

  it('keeps a named export inside the workspace', async () => {
    const { cwd, ctrl } = scenario('export-named');
    const before = await ctrl.openWorkspace(cwd);
    const sessionId = before.workspace?.sessionId;
    if (!sessionId) throw new Error('opening a workspace did not give a session');

    expect(() => ctrl.exportSession(sessionId, '../../escaped.md')).toThrow(/inside the workspace/);
    const deep = ctrl.exportSession(sessionId, join('notes', 'deep.md')).file;
    expect(deep).toBe(join(cwd, 'notes', 'deep.md'));
    expect(existsSync(deep)).toBe(true);
    await ctrl.dispose();
  });
});

describe('WorkspaceController attachments', () => {
  it('reports the eyes of the open model, in the caps a turn carries', async () => {
    const { cwd, ctrl } = scenario('attach-caps');
    await ctrl.openWorkspace(cwd);

    const seeing = await ctrl.setModel({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(seeing.attachments).toEqual({
      vision: true,
      perTurn: MAX_IMAGES_PER_TURN,
      maxBytes: MAX_IMAGE_BYTES,
    });

    // The composer reads these off the payload; a blind model has to come back blind.
    const blind = await ctrl.setModel({ provider: 'deepseek', modelId: 'deepseek-chat' });
    expect(blind.attachments.vision).toBe(false);
    await ctrl.dispose();
  });
});
