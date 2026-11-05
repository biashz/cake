import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

  it('renames and deletes sessions with their messages', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    store.saveMessages(meta.id, [{ role: 'user', content: 'hi' }]);

    store.rename(meta.id, '  parser tests  ');
    expect(store.get(meta.id)?.title).toBe('parser tests');

    store.delete(meta.id);
    expect(store.get(meta.id)).toBeUndefined();
    expect(store.messages(meta.id)).toEqual([]);
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

  it('starts a session with an empty plan and round-trips it across reopen', () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    expect(store.plan(meta.id)).toEqual([]);

    const tasks = [
      { id: 1, subject: 'read code', status: 'completed' as const },
      { id: 2, subject: 'edit file', status: 'in_progress' as const },
    ];
    store.savePlan(meta.id, tasks);
    store.close();

    const reopened = SessionStore.open(file);
    expect(reopened.plan(meta.id)).toEqual(tasks);
    expect(reopened.plan('missing')).toEqual([]);
    reopened.close();
  });

  it('saves a plan without making the session look recently active', async () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    // A gap, so the wall clock has definitely moved since create().
    await new Promise((resolve) => setTimeout(resolve, 5));

    store.savePlan(meta.id, [{ id: 1, subject: 'stay put', status: 'pending' }]);
    expect(store.get(meta.id)?.updatedAt).toBe(meta.updatedAt);
    store.close();
  });

  it('ignores an unreadable plan rather than failing the read', async () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.savePlan(meta.id, [{ id: 1, subject: 'keep', status: 'pending' }]);
    store.close();

    // A row written by something other than cake: a bare object, then a list
    // with a malformed entry in it.
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE sessions SET plan = ? WHERE id = ?').run('{"not":"a list"}', meta.id);
    const corrupt = SessionStore.open(file);
    expect(corrupt.plan(meta.id)).toEqual([]);
    corrupt.close();

    raw
      .prepare('UPDATE sessions SET plan = ? WHERE id = ?')
      .run('[{"id":1,"subject":"keep","status":"pending"},{"status":"nope"}]', meta.id);
    raw.close();
    const reopened = SessionStore.open(file);
    expect(reopened.plan(meta.id)).toEqual([{ id: 1, subject: 'keep', status: 'pending' }]);
    reopened.close();
  });
});

describe('SessionStore migration', () => {
  it('opens a database written before the plan column', () => {
    // Not defaultSessionFile: a legacy file is one cake did not create.
    const file = path.join(dir, 'legacy.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    legacy
      .prepare(
        'INSERT INTO sessions (id, cwd, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('old', dir, 'anthropic', 'm', 1, 1);
    legacy.close();

    const store = SessionStore.open(file);
    expect(store.plan('old')).toEqual([]);
    store.savePlan('old', [{ id: 1, subject: 'carried on', status: 'in_progress' }]);
    expect(store.plan('old')).toEqual([{ id: 1, subject: 'carried on', status: 'in_progress' }]);
    expect(store.messages('old')).toEqual([]);
    store.close();
  });
});
