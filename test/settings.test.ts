import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../src/permissions/settings.js';

let cwd: string;
let home: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-settings-cwd-'));
  home = await mkdtemp(path.join(tmpdir(), 'cake-settings-home-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function writeSettings(root: string, value: unknown): Promise<void> {
  const dir = path.join(root, '.cake');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify(value), 'utf8');
}

describe('loadSettings', () => {
  it('returns empty rules when no settings files exist', async () => {
    const settings = await loadSettings({ cwd, homeDir: home });
    expect(settings.permissions).toEqual({ allow: [], deny: [] });
  });

  it('merges global then project rules', async () => {
    await writeSettings(home, { permissions: { allow: ['bash(npm test*)'], deny: [] } });
    await writeSettings(cwd, {
      permissions: { allow: ['write(src/**)'], deny: ['bash(rm *)'] },
    });

    const settings = await loadSettings({ cwd, homeDir: home });
    expect(settings.permissions).toEqual({
      allow: ['bash(npm test*)', 'write(src/**)'],
      deny: ['bash(rm *)'],
    });
  });

  it('rejects invalid JSON', async () => {
    const dir = path.join(cwd, '.cake');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'settings.json'), '{ nope', 'utf8');
    await expect(loadSettings({ cwd, homeDir: home })).rejects.toThrow(/Invalid settings JSON/);
  });

  it('rejects malformed permission rules', async () => {
    await writeSettings(cwd, { permissions: { allow: ['not a rule'], deny: [] } });
    await expect(loadSettings({ cwd, homeDir: home })).rejects.toThrow(/Invalid permission rule/);
  });
});
