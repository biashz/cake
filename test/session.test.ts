import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSessionFile, SessionStore } from '../src/session/store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cake-session-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('creates and reads sessions', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'claude-sonnet-4-5' });

    expect(meta.title).toBe('');
    expect(store.get(meta.id)?.model).toBe('claude-sonnet-4-5');
    expect(store.get('missing')).toBeUndefined();
    store.close();
  });

  it('finds the most recent session per workspace', async () => {
    const store = SessionStore.inMemory();
    const a = store.create({ cwd: '/repo-a', provider: 'anthropic', model: 'm' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = store.create({ cwd: '/repo-b', provider: 'anthropic', model: 'm' });

    expect(store.latest('/repo-a')?.id).toBe(a.id);
    expect(store.latest('/repo-b')?.id).toBe(b.id);
    expect(store.latest('/repo-c')).toBeUndefined();
    store.close();
  });

  it('round-trips messages and replaces them on save', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    const first: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    store.saveMessages(meta.id, first);
    expect(store.messages(meta.id)).toEqual(first);

    const second: ModelMessage[] = [{ role: 'user', content: 'again' }];
    store.saveMessages(meta.id, second);
    expect(store.messages(meta.id)).toEqual(second);
    store.close();
  });

  it('accumulates usage, keeps the first title, and updates the model', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    store.addUsage(meta.id, { totalTokens: 100, costUsd: 0.5 });
    store.addUsage(meta.id, { totalTokens: 50, costUsd: 0.25 });
    const used = store.get(meta.id);
    expect(used?.totalTokens).toBe(150);
    expect(used?.costUsd).toBeCloseTo(0.75);

    store.setTitleIfEmpty(meta.id, 't'.repeat(100));
    expect(store.get(meta.id)?.title).toBe('t'.repeat(80));
    store.setTitleIfEmpty(meta.id, 'second prompt');
    expect(store.get(meta.id)?.title).toBe('t'.repeat(80));

    store.updateModel(meta.id, 'openai', 'gpt-5');
    expect(store.get(meta.id)?.provider).toBe('openai');
    expect(store.get(meta.id)?.model).toBe('gpt-5');
    store.close();
  });

  it('persists messages and metadata across reopen', async () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.saveMessages(meta.id, [{ role: 'user', content: 'persisted' }]);
    store.close();

    const reopened = SessionStore.open(file);
    expect(reopened.messages(meta.id)).toEqual([{ role: 'user', content: 'persisted' }]);
    expect(reopened.get(meta.id)?.cwd).toBe(dir);
    reopened.close();
  });
});
