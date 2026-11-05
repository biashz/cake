import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';

function makeTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfig(dir: string, config: unknown): void {
  mkdirSync(join(dir, '.cake'), { recursive: true });
  writeFileSync(join(dir, '.cake', 'config.json'), JSON.stringify(config));
}

describe('loadConfig', () => {
  it('defaults to deepseek when nothing is configured', () => {
    const home = makeTmp('cake-home-');
    const cwd = makeTmp('cake-cwd-');
    const cfg = loadConfig({ cwd, homeDir: home, env: {} });
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.model).toBeUndefined();
  });

  it('lets project config override global config', () => {
    const home = makeTmp('cake-home-');
    const cwd = makeTmp('cake-cwd-');
    writeConfig(home, { provider: 'anthropic', model: 'global-model' });
    writeConfig(cwd, { model: 'project-model' });

    const cfg = loadConfig({ cwd, homeDir: home, env: {} });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('project-model');
  });

  it('lets env override file config', () => {
    const home = makeTmp('cake-home-');
    const cwd = makeTmp('cake-cwd-');
    writeConfig(cwd, { provider: 'anthropic' });

    const cfg = loadConfig({
      cwd,
      homeDir: home,
      env: { CAKE_PROVIDER: 'openai', CAKE_MODEL: 'gpt-4o' },
    });
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o');
  });

  it('reads base URL from env', () => {
    const home = makeTmp('cake-home-');
    const cwd = makeTmp('cake-cwd-');
    const cfg = loadConfig({
      cwd,
      homeDir: home,
      env: {
        DEEPSEEK_BASE_URL: 'http://localhost:8081',
        ANTHROPIC_BASE_URL: 'http://localhost:8080',
      },
    });
    expect(cfg.providers.deepseek?.baseURL).toBe('http://localhost:8081');
    expect(cfg.providers.anthropic?.baseURL).toBe('http://localhost:8080');
  });

  it('merges deepseek provider settings across global and project config', () => {
    const home = makeTmp('cake-home-');
    const cwd = makeTmp('cake-cwd-');
    writeConfig(home, { providers: { deepseek: { apiKey: 'global', model: 'deepseek-chat' } } });
    writeConfig(cwd, { providers: { deepseek: { model: 'deepseek-reasoner' } } });

    const cfg = loadConfig({ cwd, homeDir: home, env: {} });
    expect(cfg.providers.deepseek).toEqual({ apiKey: 'global', model: 'deepseek-reasoner' });
  });

  it('throws a helpful error on invalid JSON', () => {
    const home = makeTmp('cake-home-');
    const cwd = makeTmp('cake-cwd-');
    mkdirSync(join(cwd, '.cake'), { recursive: true });
    writeFileSync(join(cwd, '.cake', 'config.json'), '{ not valid json');

    expect(() => loadConfig({ cwd, homeDir: home, env: {} })).toThrow(/Invalid JSON/);
  });
});
