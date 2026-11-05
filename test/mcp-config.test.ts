import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMcpConfig, mcpConfigPaths } from '../src/mcp/config.js';

let home: string;
let cwd: string;

async function writeConfig(base: string, value: unknown): Promise<void> {
  await mkdir(path.join(base, '.cake'), { recursive: true });
  await writeFile(path.join(base, '.cake', 'mcp.json'), JSON.stringify(value), 'utf8');
}

/** Builds a ${NAME} placeholder, kept out of string literals to satisfy the linter. */
const ref = (name: string) => `\${${name}}`;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'cake-mcp-home-'));
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-mcp-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('loadMcpConfig', () => {
  it('merges global and project servers, letting the project override by name', async () => {
    await writeConfig(home, {
      mcpServers: {
        shared: { command: 'global-cmd' },
        globalOnly: { command: 'only-global' },
      },
    });
    await writeConfig(cwd, {
      mcpServers: {
        shared: { command: 'project-cmd', args: ['--x'] },
        projectOnly: { url: 'https://example.com/mcp' },
      },
    });

    const { servers, files } = loadMcpConfig({ cwd, homeDir: home, env: {} });
    expect(files).toEqual([mcpConfigPaths(cwd, home).global, mcpConfigPaths(cwd, home).project]);
    expect(servers.map((server) => server.name)).toEqual(['shared', 'globalOnly', 'projectOnly']);

    const shared = servers.find((server) => server.name === 'shared');
    expect(shared).toMatchObject({
      transport: 'stdio',
      command: 'project-cmd',
      args: ['--x'],
      maxTools: 24,
      baseDir: cwd,
      scope: 'project',
      enabled: true,
    });
    expect(servers.find((server) => server.name === 'globalOnly')).toMatchObject({
      scope: 'global',
    });
    expect(servers.find((server) => server.name === 'projectOnly')).toMatchObject({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {},
    });
  });

  it('expands environment placeholders in commands, args, env, headers and cwd', async () => {
    await writeConfig(cwd, {
      mcpServers: {
        files: {
          command: ref('NODE_BIN'),
          args: [ref('SCRIPT'), `--token=${ref('TOKEN')}`],
          env: { TOKEN: ref('TOKEN') },
          cwd: 'sub/dir',
        },
        remote: {
          url: `https://${ref('HOST')}/mcp`,
          headers: { Authorization: `Bearer ${ref('TOKEN')}` },
          permission: 'read',
          maxTools: 5,
        },
      },
    });

    const { servers } = loadMcpConfig({
      cwd,
      homeDir: home,
      env: { NODE_BIN: 'node', SCRIPT: 'server.js', TOKEN: 'secret', HOST: 'api.test' },
    });
    expect(servers[0]).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['server.js', '--token=secret'],
      env: { TOKEN: 'secret' },
      cwd: path.join(cwd, 'sub', 'dir'),
    });
    expect(servers[1]).toMatchObject({
      transport: 'http',
      url: 'https://api.test/mcp',
      headers: { Authorization: 'Bearer secret' },
      permission: 'read',
      maxTools: 5,
    });
  });

  it('fails fast when a referenced environment variable is missing', async () => {
    await writeConfig(cwd, { mcpServers: { files: { command: ref('MISSING_BIN') } } });
    expect(() => loadMcpConfig({ cwd, homeDir: home, env: {} })).toThrow(/MISSING_BIN/);
  });

  it('reports malformed JSON with the offending path', async () => {
    await mkdir(path.join(cwd, '.cake'), { recursive: true });
    await writeFile(path.join(cwd, '.cake', 'mcp.json'), '{ nope', 'utf8');
    expect(() => loadMcpConfig({ cwd, homeDir: home, env: {} })).toThrow(/Invalid JSON.*mcp\.json/);
  });

  it('rejects invalid server entries at load time', async () => {
    await writeConfig(cwd, { mcpServers: { broken: { command: '' } } });
    expect(() => loadMcpConfig({ cwd, homeDir: home, env: {} })).toThrow(
      /Invalid MCP config.*broken/s,
    );
  });

  it('returns no servers when neither config file exists', () => {
    expect(loadMcpConfig({ cwd, homeDir: home, env: {} })).toEqual({ servers: [], files: [] });
  });

  it('keeps an entry switched off, and reports which scope owns it', async () => {
    await writeConfig(home, {
      mcpServers: { quiet: { command: 'global-cmd', enabled: false } },
    });
    const { servers } = loadMcpConfig({ cwd, homeDir: home, env: {} });
    expect(servers).toMatchObject([{ name: 'quiet', scope: 'global', enabled: false }]);
  });
});
