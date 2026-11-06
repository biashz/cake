import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { doctorFilePath, doctorStorePath, ensureDoctorFile } from '../src/diagnostics/fixes.js';
import { loadMcpConfig } from '../src/mcp/config.js';
import { loadSettings } from '../src/permissions/settings.js';

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'cake-fix-home-'));
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-fix-cwd-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('doctorFilePath', () => {
  it('resolves each target inside the scope it names', () => {
    const targets = [
      ['config-project', path.join(cwd, '.cake', 'config.json')],
      ['config-global', path.join(home, '.cake', 'config.json')],
      ['mcp-project', path.join(cwd, '.cake', 'mcp.json')],
      ['mcp-global', path.join(home, '.cake', 'mcp.json')],
      ['settings-project', path.join(cwd, '.cake', 'settings.json')],
      ['settings-global', path.join(home, '.cake', 'settings.json')],
    ] as const;
    for (const [target, expected] of targets) {
      expect(doctorFilePath(target, { cwd, homeDir: home })).toBe(expected);
    }
  });
});

describe('doctorStorePath', () => {
  it('points at the SQLite files, which are revealed rather than edited', () => {
    expect(doctorStorePath('sessions', { cwd, homeDir: home })).toContain('sessions');
    expect(doctorStorePath('index', { cwd, homeDir: home })).toContain('index');
  });
});

describe('ensureDoctorFile', () => {
  it('creates a missing project config that the loaders accept', async () => {
    const expected = path.join(cwd, '.cake', 'mcp.json');
    const created = await ensureDoctorFile('mcp-project', { cwd, homeDir: home });
    expect(created).toBe(expected);
    expect(JSON.parse(await readFile(expected, 'utf8'))).toEqual({ mcpServers: {} });
    expect(loadMcpConfig({ cwd, homeDir: home, env: {} }).servers).toEqual([]);
  });

  it('creates a missing settings file with empty rules', async () => {
    const expected = path.join(cwd, '.cake', 'settings.json');
    expect(await ensureDoctorFile('settings-project', { cwd, homeDir: home })).toBe(expected);
    const settings = await loadSettings({ cwd, homeDir: home });
    expect(settings.permissions).toEqual({ allow: [], deny: [] });
  });

  it('creates a missing global config as an empty object', async () => {
    const expected = path.join(home, '.cake', 'config.json');
    await ensureDoctorFile('config-global', { cwd, homeDir: home });
    expect(JSON.parse(await readFile(expected, 'utf8'))).toEqual({});
    expect(loadConfig({ cwd, homeDir: home, env: {} }).model).toBeUndefined();
  });

  it('leaves an existing file byte-identical', async () => {
    const file = path.join(cwd, '.cake', 'mcp.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"mcpServers":{"docs":{"command":"node"}}}   ', 'utf8');
    expect(await ensureDoctorFile('mcp-project', { cwd, homeDir: home })).toBe(file);
    expect(await readFile(file, 'utf8')).toBe('{"mcpServers":{"docs":{"command":"node"}}}   ');
  });
});
