import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpConfig } from '../src/mcp/config.js';
import { removeMcpServer, setMcpEnabled, setMcpServer } from '../src/mcp/write.js';

interface Pair {
  cwd: string;
  homeDir: string;
}

function pair(): Pair {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'cake-mcp-ws-')),
    homeDir: mkdtempSync(join(tmpdir(), 'cake-mcp-home-')),
  };
}

function fileFor(scope: Pair): string {
  return join(scope.cwd, '.cake', 'mcp.json');
}

function seed(scope: Pair, config: unknown): void {
  mkdirSync(join(scope.cwd, '.cake'), { recursive: true });
  writeFileSync(fileFor(scope), JSON.stringify(config, null, 2), 'utf8');
}

function read(scope: Pair): Record<string, unknown> {
  return JSON.parse(readFileSync(fileFor(scope), 'utf8')) as Record<string, unknown>;
}

function servers(scope: Pair): Record<string, unknown> {
  return read(scope).mcpServers as Record<string, unknown>;
}

const stdioDraft = {
  name: 'files',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', 'server.js'],
};

describe('setMcpServer', () => {
  it('creates the workspace file with only what was typed', async () => {
    const scope = pair();
    await setMcpServer({ ...scope, scope: 'project' }, stdioDraft);
    expect(servers(scope)).toEqual({
      files: { command: 'npx', args: ['-y', 'server.js'], enabled: true },
    });
  });

  it('omits an empty args array instead of writing a stray key', async () => {
    const scope = pair();
    await setMcpServer({ ...scope, scope: 'project' }, { ...stdioDraft, args: [] });
    expect(servers(scope).files).toEqual({ command: 'npx', enabled: true });
  });

  it('writes an http entry with its url and permission', async () => {
    const scope = pair();
    await setMcpServer(
      { ...scope, scope: 'project' },
      { name: 'remote', transport: 'http', url: 'https://api.test/mcp', permission: 'read' },
    );
    expect(servers(scope).remote).toEqual({
      url: 'https://api.test/mcp',
      enabled: true,
      permission: 'read',
    });
  });

  it('replaces the entry with the same name and keeps the others', async () => {
    const scope = pair();
    seed(scope, { mcpServers: { keeper: { command: 'keep' }, files: { command: 'old' } } });
    await setMcpServer({ ...scope, scope: 'project' }, stdioDraft);
    expect(servers(scope)).toEqual({
      keeper: { command: 'keep' },
      files: { command: 'npx', args: ['-y', 'server.js'], enabled: true },
    });
  });

  it('leaves keys the panel does not know about alone', async () => {
    const scope = pair();
    seed(scope, { mcpServers: { files: { command: 'old' } }, telemetry: false });
    await setMcpServer({ ...scope, scope: 'project' }, stdioDraft);
    expect(read(scope).telemetry).toBe(false);
  });

  it('keeps the hand-edited keys of the entry it rewrites', async () => {
    const scope = pair();
    seed(scope, {
      mcpServers: {
        files: { command: 'old', env: { TOKEN: 'x' }, cwd: '/srv', maxTools: 3 },
      },
    });
    await setMcpServer({ ...scope, scope: 'project' }, stdioDraft);
    expect(servers(scope).files).toEqual({
      env: { TOKEN: 'x' },
      cwd: '/srv',
      maxTools: 3,
      command: 'npx',
      args: ['-y', 'server.js'],
      enabled: true,
    });
  });

  it('drops the other transport when a server switches', async () => {
    const scope = pair();
    seed(scope, { mcpServers: { files: { command: 'npx', args: ['-y'], headers: { A: 'b' } } } });
    await setMcpServer(
      { ...scope, scope: 'project' },
      { name: 'files', transport: 'http', url: 'https://api.test/mcp' },
    );
    expect(servers(scope).files).toEqual({
      headers: { A: 'b' },
      url: 'https://api.test/mcp',
      enabled: true,
    });
  });

  it('clears a permission override when the form leaves it unset', async () => {
    const scope = pair();
    seed(scope, { mcpServers: { files: { command: 'old', permission: 'shell' } } });
    await setMcpServer({ ...scope, scope: 'project' }, stdioDraft);
    expect(servers(scope).files).not.toHaveProperty('permission');
  });

  it('writes the global file when asked for the global scope', async () => {
    const scope = pair();
    const file = await setMcpServer({ ...scope, scope: 'global' }, stdioDraft);
    expect(file).toBe(join(scope.homeDir, '.cake', 'mcp.json'));
    expect(existsSync(fileFor(scope))).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers).toMatchObject({
      files: { command: 'npx' },
    });
  });

  it('names the offending field and writes nothing when the draft is invalid', async () => {
    const scope = pair();
    seed(scope, { mcpServers: { keeper: { command: 'keep' } } });
    const before = readFileSync(fileFor(scope), 'utf8');

    await expect(
      setMcpServer({ ...scope, scope: 'project' }, { ...stdioDraft, name: 'bad name' }),
    ).rejects.toThrow(/Cannot save server: name/);
    await expect(
      setMcpServer({ ...scope, scope: 'project' }, { ...stdioDraft, command: '' }),
    ).rejects.toThrow(/Cannot save server: command/);
    await expect(
      setMcpServer(
        { ...scope, scope: 'project' },
        { name: 'remote', transport: 'http', url: 'not-a-url' },
      ),
    ).rejects.toThrow(/Cannot save server: url/);

    expect(readFileSync(fileFor(scope), 'utf8')).toBe(before);
  });
});

describe('removeMcpServer', () => {
  it('drops only the named server', async () => {
    const scope = pair();
    seed(scope, { mcpServers: { files: { command: 'a' }, keeper: { command: 'b' } } });
    await removeMcpServer({ ...scope, scope: 'project' }, 'files');
    expect(servers(scope)).toEqual({ keeper: { command: 'b' } });
  });

  it('refuses a name it does not have and creates no file', async () => {
    const scope = pair();
    await expect(removeMcpServer({ ...scope, scope: 'project' }, 'ghost')).rejects.toThrow(
      /No server "ghost"/,
    );
    expect(existsSync(fileFor(scope))).toBe(false);
  });
});

describe('setMcpEnabled', () => {
  it('flips the flag and keeps every other field', async () => {
    const scope = pair();
    seed(scope, {
      mcpServers: { files: { command: 'npx', args: ['-y', 's.js'], env: { TOKEN: 'x' } } },
    });
    await setMcpEnabled({ ...scope, scope: 'project' }, 'files', false);
    expect(servers(scope).files).toEqual({
      command: 'npx',
      args: ['-y', 's.js'],
      env: { TOKEN: 'x' },
      enabled: false,
    });
  });

  it('refuses a server that is not configured', async () => {
    const scope = pair();
    seed(scope, { mcpServers: {} });
    const before = readFileSync(fileFor(scope), 'utf8');
    await expect(setMcpEnabled({ ...scope, scope: 'project' }, 'ghost', true)).rejects.toThrow(
      /No server "ghost"/,
    );
    expect(readFileSync(fileFor(scope), 'utf8')).toBe(before);
  });

  it('refuses to rewrite a file it cannot parse', async () => {
    const scope = pair();
    mkdirSync(join(scope.cwd, '.cake'), { recursive: true });
    writeFileSync(fileFor(scope), '{ nope', 'utf8');
    await expect(setMcpServer({ ...scope, scope: 'project' }, stdioDraft)).rejects.toThrow(
      /invalid JSON/i,
    );
    expect(readFileSync(fileFor(scope), 'utf8')).toBe('{ nope');
  });

  it('produces entries the loader reads back', async () => {
    const scope = pair();
    await setMcpServer({ ...scope, scope: 'project' }, stdioDraft);
    await setMcpServer(
      { ...scope, scope: 'project' },
      { name: 'off', transport: 'http', url: 'https://api.test/mcp', enabled: false },
    );
    const { servers: loaded } = loadMcpConfig({ cwd: scope.cwd, homeDir: scope.homeDir, env: {} });
    expect(loaded).toMatchObject([
      { name: 'files', scope: 'project', enabled: true, args: ['-y', 'server.js'] },
      { name: 'off', scope: 'project', transport: 'http', enabled: false },
    ]);
  });
});
