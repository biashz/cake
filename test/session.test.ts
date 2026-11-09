import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CostLine } from '../src/core/cost.js';
import type { TokenUsage } from '../src/core/events.js';
import { defaultSessionFile, SessionStore } from '../src/session/store.js';

let dir: string;

function usage(totalTokens: number): TokenUsage {
  return { inputTokens: totalTokens, outputTokens: 0, totalTokens };
}

function line(overrides: Partial<CostLine> = {}): CostLine {
  return {
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    scope: 'main',
    usage: usage(150),
    costUsd: 0.001,
    priced: true,
    ...overrides,
  };
}

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

    store.addTurnUsage(meta.id, [line({ costUsd: 0.5, usage: usage(100) })]);
    store.addTurnUsage(meta.id, [line({ costUsd: 0.25, usage: usage(50) })]);
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

describe('SessionStore turn detail', () => {
  it('numbers turns per session and keeps a turn nested in one number', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    store.addTurnUsage(meta.id, [line({ costUsd: 0.01, usage: usage(100) })]);
    store.addTurnUsage(meta.id, [
      line({ costUsd: 0.02, usage: usage(80) }),
      line({
        scope: 'subagent',
        agentType: 'Explore',
        model: { provider: 'deepseek', modelId: 'deepseek-chat' },
        costUsd: 0.005,
        usage: usage(30),
      }),
    ]);

    const rows = store.turnUsage(meta.id);
    // turn + seq is the row's identity: the view keys nested lines by it.
    expect(rows.map((row) => [row.turn, row.seq])).toEqual([
      [1, 0],
      [2, 0],
      [2, 1],
    ]);
    expect(rows.map((row) => row.totalTokens)).toEqual([100, 80, 30]);
    expect(rows[2]).toMatchObject({
      scope: 'subagent',
      agentType: 'Explore',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
    expect(rows[0]?.agentType).toBe('');
    store.close();
  });

  it('writes no rows and no roll-up for a turn that spent nothing', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    store.addTurnUsage(meta.id, []);
    expect(store.turnUsage(meta.id)).toEqual([]);
    expect(store.get(meta.id)?.totalTokens).toBe(0);

    store.addTurnUsage(meta.id, [line({ usage: usage(10) })]);
    expect(store.turnUsage(meta.id).map((row) => row.turn)).toEqual([1]);
    store.close();
  });

  it('keeps the session roll-up equal to the sum of its rows', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    store.addTurnUsage(meta.id, [line({ costUsd: 0.03, usage: usage(120) })]);
    store.addTurnUsage(meta.id, [
      line({ costUsd: 0.02, usage: usage(90) }),
      line({ scope: 'subagent', agentType: 'Explore', costUsd: 0.01, usage: usage(40) }),
    ]);

    const rows = store.turnUsage(meta.id);
    const session = store.get(meta.id);
    expect(rows.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(session?.totalTokens);
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBeCloseTo(session?.costUsd ?? 0, 10);
    store.close();
  });

  it('separates tokens with no rate from priced ones', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    store.addTurnUsage(meta.id, [
      line({ costUsd: 0.01, usage: usage(100) }),
      line({
        model: { provider: 'ollama', modelId: 'llama3' },
        priced: false,
        costUsd: 0,
        usage: usage(60),
      }),
    ]);

    const rows = store.turnUsage(meta.id);
    expect(rows.map((row) => row.priced)).toEqual([true, false]);
    expect(store.workspaceUsage('/repo').unpricedTokens).toBe(60);
    store.close();
  });

  it('reads turn detail back after reopen', () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.addTurnUsage(meta.id, [
      line({ costUsd: 0.02, usage: usage(120) }),
      line({ scope: 'subagent', agentType: 'Plan', costUsd: 0.01, usage: usage(30) }),
    ]);
    store.close();

    const reopened = SessionStore.open(file);
    const rows = reopened.turnUsage(meta.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ turn: 1, scope: 'main', totalTokens: 120 });
    expect(rows[1]).toMatchObject({ turn: 1, scope: 'subagent', agentType: 'Plan' });
    expect(rows[0]?.occurredAt).toBeGreaterThan(0);
    expect(reopened.turnUsage('missing')).toEqual([]);
    reopened.close();
  });

  it('totals only the sessions of one workspace', () => {
    const store = SessionStore.inMemory();
    const here = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    const other = store.create({ cwd: '/elsewhere', provider: 'anthropic', model: 'm' });

    store.addTurnUsage(here.id, [line({ costUsd: 0.04, usage: usage(200) })]);
    store.addTurnUsage(here.id, [
      line({
        priced: false,
        costUsd: 0,
        usage: usage(70),
        model: { provider: 'mystery', modelId: 'x' },
      }),
    ]);
    store.addTurnUsage(other.id, [line({ costUsd: 0.5, usage: usage(1_000) })]);

    const spend = store.workspaceUsage('/repo');
    expect(spend.sessions).toBe(1);
    expect(spend.totalTokens).toBe(270);
    expect(spend.costUsd).toBeCloseTo(0.04, 10);
    expect(spend.unpricedTokens).toBe(70);
    expect(store.workspaceUsage('/elsewhere').costUsd).toBeCloseTo(0.5);
    expect(store.workspaceUsage('/nowhere')).toEqual({
      sessions: 0,
      costUsd: 0,
      totalTokens: 0,
      unpricedTokens: 0,
    });
    store.close();
  });

  it('counts a legacy roll-up in the workspace total without inventing rows', () => {
    // Not defaultSessionFile: pre-detail sessions are ones cake wrote before this table.
    const file = path.join(dir, 'legacy.db');
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        plan TEXT NOT NULL DEFAULT '[]'
      );
    `);
    raw
      .prepare(
        'INSERT INTO sessions (id, cwd, provider, model, total_tokens, cost_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('old', '/repo', 'anthropic', 'm', 900, 0.2, 1, 1);
    raw.close();

    const store = SessionStore.open(file);
    expect(store.turnUsage('old')).toEqual([]);
    expect(store.workspaceUsage('/repo')).toEqual({
      sessions: 1,
      costUsd: 0.2,
      totalTokens: 900,
      unpricedTokens: 0,
    });
    store.close();
  });

  it('drops turn detail with the session', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    store.addTurnUsage(meta.id, [line({ costUsd: 0.01, usage: usage(100) })]);
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'turn-1',
      prompt: 'do the thing',
      startedAt: 1,
    });

    store.delete(meta.id);
    expect(store.turnUsage(meta.id)).toEqual([]);
    expect(store.turnCheckpoints(meta.id)).toEqual([]);
    expect(store.workspaceUsage('/repo').totalTokens).toBe(0);
    store.close();
  });
});

describe('SessionStore turn checkpoints', () => {
  /** Rewrite the archive table to the shape an older cake wrote, then fill it. */
  function writeOldLinks(
    file: string,
    rows: Array<{ session: string; turn: number; id: string; prompt?: string }>,
  ): void {
    const kept = new DatabaseSync(file);
    const both = rows.every((row) => row.prompt !== undefined);
    kept.exec('DROP TABLE IF EXISTS turn_checkpoints');
    kept.exec(
      `CREATE TABLE turn_checkpoints (
         session_id TEXT NOT NULL,
         turn INTEGER NOT NULL,
         checkpoint_id TEXT NOT NULL${both ? ",\n         prompt TEXT NOT NULL DEFAULT ''" : ''},
         PRIMARY KEY (session_id, turn)
       )`,
    );
    for (const row of rows) {
      if (row.prompt === undefined) {
        kept
          .prepare('INSERT INTO turn_checkpoints VALUES (?, ?, ?)')
          .run(row.session, row.turn, row.id);
      } else {
        kept
          .prepare('INSERT INTO turn_checkpoints VALUES (?, ?, ?, ?)')
          .run(row.session, row.turn, row.id, row.prompt);
      }
    }
    kept.close();
  }

  it('names an archive for a turn that billed nothing', () => {
    // The turn that threw or was stopped has no cost lines and often no
    // transcript at all, and it is the one whose files nobody wants to keep.
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: '1700000000000-aaaa1111',
      prompt: 'split the parser',
      startedAt: 1_700_000_000_000,
    });

    expect(store.turnUsage(meta.id)).toEqual([]);
    expect(store.turnCheckpoints(meta.id)).toEqual([
      {
        checkpointId: '1700000000000-aaaa1111',
        prompt: 'split the parser',
        startedAt: 1_700_000_000_000,
      },
    ]);
    store.close();
  });

  it('keeps the archive of a retry beside the one that failed', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    // Turn-numbered, these two shared a key and the retry overwrote the first,
    // hiding the very archive someone would want.
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'failed',
      prompt: 'fix it',
      startedAt: 2,
    });
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'retry',
      prompt: 'fix it',
      startedAt: 3,
    });

    expect(store.turnCheckpoints(meta.id).map((row) => row.checkpointId)).toEqual([
      'failed',
      'retry',
    ]);
    store.close();
  });

  it('lists a session’s archives oldest first, however they were written', () => {
    const store = SessionStore.inMemory();
    const meta = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    // The dates and the ids disagree on purpose. A migrated archive carries the
    // moment its turn billed, which is later than the millisecond in its own id,
    // so id order alone would put it after a newer turn that started before it.
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'third',
      prompt: 'c',
      startedAt: 30,
    });
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'first',
      prompt: 'a',
      startedAt: 10,
    });
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'second',
      prompt: 'b',
      startedAt: 20,
    });
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'a-early-id',
      prompt: 'd',
      startedAt: 15,
    });

    expect(store.turnCheckpoints(meta.id).map((row) => row.checkpointId)).toEqual([
      'first',
      'a-early-id',
      'second',
      'third',
    ]);
    store.close();
  });

  it('reads the mapping back after reopen', () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: 'turn-7',
      prompt: 'split the parser',
      startedAt: 12,
    });
    store.close();

    const reopened = SessionStore.open(file);
    expect(reopened.turnCheckpoints(meta.id)).toEqual([
      { checkpointId: 'turn-7', prompt: 'split the parser', startedAt: 12 },
    ]);
    reopened.close();
  });

  it('dates a migrated archive from the turn that billed it', () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const meta = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.addTurnUsage(meta.id, [line()]);
    const billedAt = store.turnUsage(meta.id)[0]?.occurredAt;
    store.close();

    // The old table had no timestamp of its own; it leaned on the billing row
    // that a failed turn never got, which is why the key moved.
    writeOldLinks(file, [{ session: meta.id, turn: 1, id: 'turn-9', prompt: 'rename the parser' }]);

    const reopened = SessionStore.open(file);
    expect(reopened.turnCheckpoints(meta.id)).toEqual([
      { checkpointId: 'turn-9', prompt: 'rename the parser', startedAt: billedAt },
    ]);
    reopened.close();
  });

  it('rekeys an archive link written before the prompt was kept', () => {
    const file = path.join(dir, 'old.db');
    writeOldLinks(file, [{ session: 's-1', turn: 4, id: 'turn-9' }]);

    const store = SessionStore.open(file);
    // An archive with no ask beside it is honest about it: a card cannot claim it.
    expect(store.turnCheckpoints('s-1')).toEqual([
      { checkpointId: 'turn-9', prompt: '', startedAt: 0 },
    ]);
    store.recordCheckpoint({
      sessionId: 's-1',
      checkpointId: 'turn-10',
      prompt: 'and now this',
      startedAt: 5,
    });
    // A migrated archive has no timestamp of its own, so it keeps the front of
    // the list, where the oldest turn belongs.
    expect(store.turnCheckpoints('s-1').map((row) => row.checkpointId)).toEqual([
      'turn-9',
      'turn-10',
    ]);
    store.close();
  });

  it('names the ask behind every archive of the workspace it was asked about', () => {
    const store = SessionStore.inMemory();
    const here = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    const also = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    const elsewhere = store.create({ cwd: '/other', provider: 'anthropic', model: 'm' });
    // The undo archive belongs to the folder, not to one conversation in it, so
    // a number picked from its list has to be answerable across all of them.
    store.recordCheckpoint({
      sessionId: here.id,
      checkpointId: 'a',
      prompt: 'fix the parser',
      startedAt: 1,
    });
    store.recordCheckpoint({
      sessionId: also.id,
      checkpointId: 'b',
      prompt: 'add a test',
      startedAt: 2,
    });
    store.recordCheckpoint({
      sessionId: elsewhere.id,
      checkpointId: 'c',
      prompt: 'somewhere else',
      startedAt: 3,
    });

    expect(store.checkpointAsks('/repo')).toEqual(
      new Map([
        ['a', 'fix the parser'],
        ['b', 'add a test'],
      ]),
    );
    expect(store.checkpointAsks('/other').size).toBe(1);
    expect(store.checkpointAsks('/nothing-here')).toEqual(new Map());
    store.close();
  });

  it('leaves the parent’s turns out of a fork', () => {
    const store = SessionStore.inMemory();
    const parent = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    store.saveMessages(parent.id, [{ role: 'user', content: 'before the fork' }]);
    store.recordCheckpoint({
      sessionId: parent.id,
      checkpointId: 'turn-1',
      prompt: 'before the fork',
      startedAt: 1,
    });
    const child = store.fork(parent.id);

    // The fork never ran those turns, so it cannot give them back.
    expect(store.turnCheckpoints(child.id)).toEqual([]);
    store.recordCheckpoint({
      sessionId: child.id,
      checkpointId: 'child-1',
      prompt: 'the branch',
      startedAt: 2,
    });
    expect(store.turnCheckpoints(child.id)).toEqual([
      { checkpointId: 'child-1', prompt: 'the branch', startedAt: 2 },
    ]);
    expect(store.turnCheckpoints(parent.id)).toHaveLength(1);
    store.close();
  });
});

describe('SessionStore fork', () => {
  it('copies the transcript and plan into a session that has spent nothing', () => {
    const store = SessionStore.inMemory();
    const parent = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    store.setTitleIfEmpty(parent.id, 'fix the parser');
    const messages: ModelMessage[] = [
      { role: 'user', content: 'fix the parser' },
      { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    ];
    store.saveMessages(parent.id, messages);
    store.savePlan(parent.id, [{ id: 1, subject: 'read the tokenizer', status: 'completed' }]);
    store.addTurnUsage(parent.id, [line()]);

    const child = store.fork(parent.id);

    expect(child.id).not.toBe(parent.id);
    expect(child.parentId).toBe(parent.id);
    expect(child.title).toBe('fork: fix the parser');
    expect(child.cwd).toBe('/repo');
    expect(store.messages(child.id)).toEqual(messages);
    expect(store.plan(child.id)).toEqual([
      { id: 1, subject: 'read the tokenizer', status: 'completed' },
    ]);
    // The fork has billed nothing, and the parent keeps what it paid for.
    expect(child.totalTokens).toBe(0);
    expect(child.costUsd).toBe(0);
    expect(store.turnUsage(child.id)).toEqual([]);
    expect(store.get(parent.id)?.totalTokens).toBe(150);
    store.close();
  });

  it('lets the first prompt of an untitled fork name it', () => {
    const store = SessionStore.inMemory();
    const parent = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });

    const child = store.fork(parent.id);
    expect(child.title).toBe('');

    store.setTitleIfEmpty(child.id, 'try the other parser');
    expect(store.get(child.id)?.title).toBe('try the other parser');
    store.close();
  });

  it('keeps the conversation when the parent is deleted', () => {
    const store = SessionStore.inMemory();
    const parent = store.create({ cwd: '/repo', provider: 'anthropic', model: 'm' });
    store.saveMessages(parent.id, [
      { role: 'user', content: 'keep me' },
      { role: 'assistant', content: [{ type: 'text', text: 'kept' }] },
    ]);

    const child = store.fork(parent.id);
    store.delete(parent.id);

    expect(store.get(parent.id)).toBeUndefined();
    expect(store.messages(child.id)).toHaveLength(2);
    expect(store.get(child.id)?.parentId).toBe(parent.id);
    store.close();
  });

  it('refuses to fork a session that is not there', () => {
    const store = SessionStore.inMemory();
    expect(() => store.fork('nope')).toThrow(/Unknown session "nope"/);
    store.close();
  });

  it('carries the transcript across a reopen', () => {
    const file = defaultSessionFile(dir);
    const store = SessionStore.open(file);
    const parent = store.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    store.saveMessages(parent.id, [{ role: 'user', content: 'persisted before forking' }]);
    const child = store.fork(parent.id);
    store.close();

    const reopened = SessionStore.open(file);
    expect(reopened.messages(child.id)).toEqual([
      { role: 'user', content: 'persisted before forking' },
    ]);
    expect(reopened.get(child.id)?.parentId).toBe(parent.id);
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
    // The added parent_id column reads as an original, and an old row can be forked.
    expect(store.get('old')?.parentId).toBeNull();
    expect(store.fork('old').parentId).toBe('old');
    store.close();
  });
});
