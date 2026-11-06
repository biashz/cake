import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDoctor, runDoctor } from '../src/diagnostics/doctor.js';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'cake-doctor-home-'));
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-doctor-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

function find(report: Awaited<ReturnType<typeof runDoctor>>, label: string) {
  return report.checks.find((check) => check.label === label);
}

describe('runDoctor', () => {
  it('reports a ready environment with keys, MCP servers and a clean workspace', async () => {
    await mkdir(path.join(cwd, '.cake'), { recursive: true });
    await writeFile(
      path.join(cwd, '.cake', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['server.mjs'] } } }),
      'utf8',
    );

    const report = await runDoctor({
      cwd,
      homeDir: home,
      env: { DEEPSEEK_API_KEY: 'd', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'b' },
    });

    expect(report.ok).toBe(true);
    expect(find(report, 'deepseek API key')?.status).toBe('ok');
    expect(find(report, 'anthropic API key')?.status).toBe('ok');
    expect(find(report, 'semantic search')?.status).toBe('ok');
    expect(find(report, 'MCP servers')?.detail).toContain('docs (stdio)');
    expect(find(report, 'sessions')?.detail).toContain('none yet');
    expect(find(report, 'code index')?.status).toBe('warn');
    expect(formatDoctor(report)).toContain('ready');
  });

  it('flags a missing key and disabled semantic search as warnings', async () => {
    const report = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(report.ok).toBe(true);
    expect(find(report, 'deepseek API key')?.status).toBe('warn');
    expect(find(report, 'anthropic API key')?.status).toBe('warn');
    expect(find(report, 'openai API key')?.status).toBe('warn');
    expect(find(report, 'semantic search')?.status).toBe('warn');
    expect(formatDoctor(report)).toMatch(/ready \(\d+ warnings?\)/);
  });

  it('fails on an unsupported Node version', async () => {
    const report = await runDoctor({
      cwd,
      homeDir: home,
      env: { ANTHROPIC_API_KEY: 'a' },
      nodeVersion: '20.11.0',
    });
    expect(report.ok).toBe(false);
    expect(find(report, 'Node >= 22.5')?.status).toBe('fail');
    expect(formatDoctor(report)).toContain('1 failure');
  });

  it('surfaces broken settings and MCP config as failures', async () => {
    await mkdir(path.join(cwd, '.cake'), { recursive: true });
    await writeFile(path.join(cwd, '.cake', 'settings.json'), '{ nope', 'utf8');
    await writeFile(
      path.join(cwd, '.cake', 'mcp.json'),
      JSON.stringify({ mcpServers: { broken: { command: '' } } }),
      'utf8',
    );

    const report = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(report.ok).toBe(false);
    expect(find(report, 'permission settings')?.status).toBe('fail');
    expect(find(report, 'MCP servers')?.status).toBe('fail');
  });
});

describe('runDoctor fixes', () => {
  it('points a missing provider key at the key it needs', async () => {
    const report = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(report, 'deepseek API key')?.fix).toEqual({
      kind: 'set-key',
      provider: 'deepseek',
      envVar: 'DEEPSEEK_API_KEY',
    });
    expect(find(report, 'semantic search')?.fix).toEqual({
      kind: 'set-key',
      provider: 'openai',
      envVar: 'OPENAI_API_KEY',
    });

    const configured = await runDoctor({
      cwd,
      homeDir: home,
      env: { ANTHROPIC_API_KEY: 'a' },
    });
    expect(find(configured, 'anthropic API key')?.fix).toBeUndefined();
  });

  it('offers to build the index when embeddings are ready and reveal it when broken', async () => {
    const unindexed = await runDoctor({
      cwd,
      homeDir: home,
      env: { OPENAI_API_KEY: 'b', ANTHROPIC_API_KEY: 'a' },
    });
    expect(find(unindexed, 'code index')?.fix).toEqual({ kind: 'reindex' });

    const withoutKey = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(withoutKey, 'code index')?.fix).toEqual({
      kind: 'set-key',
      provider: 'openai',
      envVar: 'OPENAI_API_KEY',
    });
  });

  it('has no index fix until a workspace is open', async () => {
    const report = await runDoctor({
      cwd,
      homeDir: home,
      env: { OPENAI_API_KEY: 'b' },
      hasWorkspace: false,
    });
    expect(find(report, 'code index')?.fix).toEqual({ kind: 'open-workspace' });
  });

  it('reload is the fix once servers exist, and opening the file is the fix while none do', async () => {
    const empty = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(empty, 'MCP servers')?.fix).toEqual({ kind: 'open-file', target: 'mcp-project' });

    await mkdir(path.join(cwd, '.cake'), { recursive: true });
    await writeFile(
      path.join(cwd, '.cake', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['server.mjs'] } } }),
      'utf8',
    );
    const live = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(live, 'MCP servers')?.fix).toEqual({ kind: 'reload-mcp' });
  });

  it('opens the file that actually holds the broken config', async () => {
    await mkdir(path.join(cwd, '.cake'), { recursive: true });
    await writeFile(
      path.join(cwd, '.cake', 'mcp.json'),
      JSON.stringify({ mcpServers: { broken: { command: '' } } }),
      'utf8',
    );
    const projectFirst = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(projectFirst, 'MCP servers')?.fix).toEqual({
      kind: 'open-file',
      target: 'mcp-project',
    });

    await rm(path.join(cwd, '.cake', 'mcp.json'));
    await mkdir(path.join(home, '.cake'), { recursive: true });
    await writeFile(path.join(home, '.cake', 'mcp.json'), '{ broken', 'utf8');
    const globalOnly = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(globalOnly, 'MCP servers')?.fix).toEqual({
      kind: 'open-file',
      target: 'mcp-global',
    });
  });

  it('points a broken settings file at the settings file', async () => {
    await mkdir(path.join(cwd, '.cake'), { recursive: true });
    await writeFile(path.join(cwd, '.cake', 'settings.json'), '{ nope', 'utf8');
    const report = await runDoctor({ cwd, homeDir: home, env: {} });
    expect(find(report, 'permission settings')?.fix).toEqual({
      kind: 'open-file',
      target: 'settings-project',
    });
  });
});
