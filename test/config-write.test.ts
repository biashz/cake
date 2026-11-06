import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { setPricingEntry, setProviderApiKey, updateProjectConfig } from '../src/config/write.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'cake-write-'));
}

function seed(cwd: string, config: unknown): void {
  mkdirSync(join(cwd, '.cake'), { recursive: true });
  writeFileSync(join(cwd, '.cake', 'config.json'), JSON.stringify(config, null, 2));
}

function projectFile(cwd: string): string {
  return join(cwd, '.cake', 'config.json');
}

function read(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(projectFile(cwd), 'utf8')) as Record<string, unknown>;
}

describe('setPricingEntry', () => {
  it('creates the config file and the rate together', async () => {
    const cwd = workspace();
    const file = await setPricingEntry(cwd, 'anthropic/sonnet', { inputPer1M: 2, outputPer1M: 9 });

    expect(file).toBe(projectFile(cwd));
    expect(read(cwd).pricing).toEqual({ 'anthropic/sonnet': { inputPer1M: 2, outputPer1M: 9 } });
    expect(loadConfig({ cwd, homeDir: workspace(), env: {} }).pricing).toEqual({
      'anthropic/sonnet': { inputPer1M: 2, outputPer1M: 9 },
    });
  });

  it('keeps keys and rates cake does not know about', async () => {
    const cwd = workspace();
    seed(cwd, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      customFlag: { keep: true },
      pricing: { 'deepseek/': { inputPer1M: 0.1, outputPer1M: 0.2 } },
    });

    await setPricingEntry(cwd, 'anthropic/opus', { inputPer1M: 10, outputPer1M: 30 });

    expect(read(cwd)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      customFlag: { keep: true },
      pricing: {
        'deepseek/': { inputPer1M: 0.1, outputPer1M: 0.2 },
        'anthropic/opus': { inputPer1M: 10, outputPer1M: 30 },
      },
    });
  });

  it('drops a rate with null so the built-in card answers again', async () => {
    const cwd = workspace();
    seed(cwd, { pricing: { 'anthropic/sonnet': { inputPer1M: 1, outputPer1M: 4 } } });

    await setPricingEntry(cwd, 'anthropic/sonnet', null);

    expect(read(cwd).pricing).toEqual({});
    expect(loadConfig({ cwd, homeDir: workspace(), env: {} }).pricing).toEqual({});
  });

  it('leaves an unreadable config file exactly as it was', async () => {
    const cwd = workspace();
    const broken = '{ "provider": ';
    mkdirSync(join(cwd, '.cake'), { recursive: true });
    writeFileSync(projectFile(cwd), broken);

    await expect(
      setPricingEntry(cwd, 'anthropic/sonnet', { inputPer1M: 1, outputPer1M: 2 }),
    ).rejects.toThrow(/invalid JSON/i);
    expect(readFileSync(projectFile(cwd), 'utf8')).toBe(broken);
  });

  it('refuses to flatten a config that is not an object', async () => {
    const cwd = workspace();
    mkdirSync(join(cwd, '.cake'), { recursive: true });
    writeFileSync(projectFile(cwd), '[1, 2]', 'utf8');
    await expect(setPricingEntry(cwd, 'x/y', { inputPer1M: 1, outputPer1M: 1 })).rejects.toThrow(
      /must contain a JSON object/,
    );
  });

  it('leaves only the config file behind when the edit lands', async () => {
    const cwd = workspace();
    await setPricingEntry(cwd, 'openai/gpt-4o', { inputPer1M: 2.5, outputPer1M: 10 });
    expect(readdirSync(join(cwd, '.cake'))).toEqual(['config.json']);
  });
});

describe('updateProjectConfig', () => {
  it('starts from an empty object when there is no file', async () => {
    const cwd = workspace();
    await updateProjectConfig(cwd, (config) => ({ ...config, model: 'claude-sonnet-4-5' }));
    expect(read(cwd)).toEqual({ model: 'claude-sonnet-4-5' });
  });

  it('ends the file with a newline so diffs stay clean', async () => {
    const cwd = workspace();
    await updateProjectConfig(cwd, (config) => ({ ...config, provider: 'deepseek' }));
    expect(readFileSync(projectFile(cwd), 'utf8').endsWith('}\n')).toBe(true);
  });
});

describe('setProviderApiKey', () => {
  it('writes the key to the global config, not the workspace', async () => {
    const home = workspace();
    const cwd = workspace();

    const file = await setProviderApiKey(home, 'anthropic', ' sk-ant-1 ');

    expect(file).toBe(join(home, '.cake', 'config.json'));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      providers: { anthropic: { apiKey: 'sk-ant-1' } },
    });
    expect(existsSync(projectFile(cwd))).toBe(false);
    expect(loadConfig({ cwd, homeDir: home, env: {} }).providers.anthropic?.apiKey).toBe(
      'sk-ant-1',
    );
  });

  it('adds the key to an existing provider entry without losing its other fields', async () => {
    const home = workspace();
    seed(home, {
      model: 'claude-sonnet-4-5',
      providers: { anthropic: { baseURL: 'https://proxy.internal/v1' } },
      customFlag: { keep: true },
    });

    await setProviderApiKey(home, 'anthropic', 'sk-ant-2');

    expect(JSON.parse(readFileSync(projectFile(home), 'utf8'))).toEqual({
      model: 'claude-sonnet-4-5',
      providers: { anthropic: { baseURL: 'https://proxy.internal/v1', apiKey: 'sk-ant-2' } },
      customFlag: { keep: true },
    });
  });

  it('refuses a blank key and leaves no file behind', async () => {
    const home = workspace();
    await expect(setProviderApiKey(home, 'openai', '   ')).rejects.toThrow(/cannot be empty/);
    expect(existsSync(join(home, '.cake', 'config.json'))).toBe(false);
  });

  it('refuses a provider the config schema has no room for', async () => {
    const home = workspace();
    await expect(setProviderApiKey(home, 'gemini', 'x')).rejects.toThrow(/Unknown provider/);
    expect(existsSync(join(home, '.cake', 'config.json'))).toBe(false);
  });

  it('leaves an unreadable global config exactly as it was', async () => {
    const home = workspace();
    const broken = '{ "providers": ';
    mkdirSync(join(home, '.cake'), { recursive: true });
    writeFileSync(projectFile(home), broken);

    await expect(setProviderApiKey(home, 'deepseek', 'x')).rejects.toThrow(/invalid JSON/i);
    expect(readFileSync(projectFile(home), 'utf8')).toBe(broken);
  });
});

describe('loadConfig pricing merge', () => {
  it('lets a project rate override the global one for the same pattern', () => {
    const home = workspace();
    const cwd = workspace();
    seed(home, { pricing: { 'anthropic/sonnet': { inputPer1M: 3, outputPer1M: 15 } } });
    seed(cwd, { pricing: { 'anthropic/sonnet': { inputPer1M: 0.5, outputPer1M: 2 } } });

    expect(loadConfig({ cwd, homeDir: home, env: {} }).pricing).toEqual({
      'anthropic/sonnet': { inputPer1M: 0.5, outputPer1M: 2 },
    });
  });

  it('keeps a global-only rate when the project prices something else', () => {
    const home = workspace();
    const cwd = workspace();
    seed(home, { pricing: { 'openai/gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 } } });
    seed(cwd, { pricing: { 'deepseek/': { inputPer1M: 0, outputPer1M: 0 } } });

    expect(Object.keys(loadConfig({ cwd, homeDir: home, env: {} }).pricing).sort()).toEqual([
      'deepseek/',
      'openai/gpt-4o',
    ]);
  });

  it('rejects a rate that is not a number', () => {
    const home = workspace();
    const cwd = workspace();
    seed(cwd, { pricing: { 'anthropic/sonnet': { inputPer1M: 'three', outputPer1M: 15 } } });

    expect(() => loadConfig({ cwd, homeDir: home, env: {} })).toThrow(/pricing/);
  });
});
