import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceController } from '../src/desktop/controller.js';

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
