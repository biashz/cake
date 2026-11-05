import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSettings, loadSettingsLayers } from '../src/permissions/settings.js';
import { addRule, moveRule, normalizeRule, removeRule } from '../src/permissions/write.js';

function pair(): { cwd: string; homeDir: string } {
  return {
    cwd: mkdtempSync(join(tmpdir(), 'cake-rules-ws-')),
    homeDir: mkdtempSync(join(tmpdir(), 'cake-rules-home-')),
  };
}

function seed(file: string, config: unknown): void {
  mkdirSync(join(file, '.cake'), { recursive: true });
  writeFileSync(join(file, '.cake', 'settings.json'), JSON.stringify(config, null, 2));
}

function settingsFile(scope: { cwd: string; homeDir: string }): string {
  return join(scope.cwd, '.cake', 'settings.json');
}

function exists(file: string): boolean {
  return existsSync(file);
}

function read(scope: { cwd: string; homeDir: string }): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile(scope), 'utf8')) as Record<string, unknown>;
}

describe('normalizeRule', () => {
  it('trims and keeps the pattern verbatim', () => {
    expect(normalizeRule('  bash(git log *)  ')).toBe('bash(git log *)');
  });

  it('rejects what the matcher would silently ignore', () => {
    expect(() => normalizeRule('')).toThrow(/tool name/);
    expect(() => normalizeRule('9lives')).toThrow(/Invalid rule/);
    expect(() => normalizeRule('bash(git log')).toThrow(/Invalid rule/);
    expect(() => normalizeRule(`read(${'*'.repeat(300)})`)).toThrow(/too long/);
  });
});

describe('addRule', () => {
  it('creates the settings file and the rule together', async () => {
    const scope = pair();
    const file = await addRule({ ...scope, scope: 'project', list: 'allow' }, 'read(src/*)');

    expect(file).toBe(settingsFile(scope));
    expect(read(scope).permissions).toEqual({ allow: ['read(src/*)'], deny: [] });
    expect(
      (await loadSettings({ cwd: scope.cwd, homeDir: scope.homeDir })).permissions.allow,
    ).toEqual(['read(src/*)']);
  });

  it('keeps keys and lists cake does not touch', async () => {
    const scope = pair();
    seed(scope.cwd, {
      model: 'claude-sonnet-4-5',
      customFlag: { keep: true },
      permissions: { allow: ['read'], deny: ['bash(rm *)'] },
    });

    await addRule({ ...scope, scope: 'project', list: 'allow' }, 'bash(npm test*)');

    const written = read(scope);
    expect(written.model).toBe('claude-sonnet-4-5');
    expect(written.customFlag).toEqual({ keep: true });
    expect(written.permissions).toEqual({
      allow: ['read', 'bash(npm test*)'],
      deny: ['bash(rm *)'],
    });
  });

  it('writes the user-wide file for the global scope', async () => {
    const scope = pair();
    await addRule({ ...scope, scope: 'global', list: 'deny' }, 'edit(.git/*)');

    expect(JSON.parse(readFileSync(join(scope.homeDir, '.cake', 'settings.json'), 'utf8'))).toEqual(
      {
        permissions: { allow: [], deny: ['edit(.git/*)'] },
      },
    );
  });

  it('refuses a rule the other scope already carries', async () => {
    const scope = pair();
    seed(scope.homeDir, { permissions: { allow: ['read'], deny: [] } });

    await expect(addRule({ ...scope, scope: 'project', list: 'allow' }, 'read')).rejects.toThrow(
      /already in the global allow rules/,
    );
    expect(exists(settingsFile(scope))).toBe(false);
  });

  it('leaves an unparseable file alone', async () => {
    const scope = pair();
    mkdirSync(join(scope.cwd, '.cake'), { recursive: true });
    const broken = '{ "permissions": ';
    writeFileSync(settingsFile(scope), broken, 'utf8');

    await expect(addRule({ ...scope, scope: 'project', list: 'allow' }, 'read')).rejects.toThrow(
      /Invalid settings JSON/,
    );
    expect(readFileSync(settingsFile(scope), 'utf8')).toBe(broken);
  });

  it('rejects a malformed rule before touching the disk', async () => {
    const scope = pair();
    await expect(
      addRule({ ...scope, scope: 'project', list: 'deny' }, 'bash rm -rf'),
    ).rejects.toThrow(/Invalid rule/);
    expect(() => readFileSync(settingsFile(scope), 'utf8')).toThrow();
  });
});

describe('removeRule', () => {
  it('drops only the named rule', async () => {
    const scope = pair();
    seed(scope.cwd, { permissions: { allow: ['read', 'bash(npm test*)'], deny: ['bash(rm *)'] } });

    await removeRule({ ...scope, scope: 'project', list: 'allow' }, 'bash(npm test*)');

    expect(read(scope).permissions).toEqual({ allow: ['read'], deny: ['bash(rm *)'] });
  });

  it('says so when the rule is not in that scope', async () => {
    const scope = pair();
    seed(scope.cwd, { permissions: { allow: ['read'], deny: [] } });
    seed(scope.homeDir, { permissions: { allow: ['bash(npm test*)'], deny: [] } });

    await expect(
      removeRule({ ...scope, scope: 'project', list: 'allow' }, 'bash(npm test*)'),
    ).rejects.toThrow(/No allow rule "bash\(npm test\*\)" in the workspace rules/);
  });
});

describe('moveRule', () => {
  it('reorders within its own scope and keeps the file valid', async () => {
    const scope = pair();
    seed(scope.cwd, {
      permissions: { allow: ['read', 'bash(npm test*)', 'web_search'], deny: [] },
    });

    await moveRule({ ...scope, scope: 'project', list: 'allow' }, 'web_search', -1);

    expect(read(scope).permissions).toEqual({
      allow: ['read', 'web_search', 'bash(npm test*)'],
      deny: [],
    });
  });

  it('does nothing at the ends of the list', async () => {
    const scope = pair();
    seed(scope.cwd, { permissions: { allow: ['read', 'web_search'], deny: [] } });

    await moveRule({ ...scope, scope: 'project', list: 'allow' }, 'read', -1);
    await moveRule({ ...scope, scope: 'project', list: 'allow' }, 'web_search', 1);

    expect(read(scope).permissions).toEqual({ allow: ['read', 'web_search'], deny: [] });
  });

  it('never moves a rule into another scope', async () => {
    const scope = pair();
    seed(scope.cwd, { permissions: { allow: ['read'], deny: [] } });
    seed(scope.homeDir, { permissions: { allow: ['web_search'], deny: [] } });

    await moveRule({ ...scope, scope: 'project', list: 'allow' }, 'read', 1);

    expect(read(scope).permissions).toEqual({ allow: ['read'], deny: [] });
    expect(
      JSON.parse(readFileSync(join(scope.homeDir, '.cake', 'settings.json'), 'utf8')).permissions
        .allow,
    ).toEqual(['web_search']);
  });
});

describe('loadSettingsLayers', () => {
  it('reports which file each rule came from, global first', async () => {
    const scope = pair();
    seed(scope.homeDir, { permissions: { allow: ['read'], deny: [] } });
    seed(scope.cwd, { permissions: { allow: [], deny: ['bash(rm *)'] } });

    const layers = await loadSettingsLayers({ cwd: scope.cwd, homeDir: scope.homeDir });

    expect(layers.map((layer) => layer.scope)).toEqual(['global', 'project']);
    expect(layers.map((layer) => layer.permissions.allow.concat(layer.permissions.deny))).toEqual([
      ['read'],
      ['bash(rm *)'],
    ]);
  });
});
