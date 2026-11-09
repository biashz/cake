import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revertTurn } from '../src/cli/revert.js';
import { CheckpointStore } from '../src/core/checkpoints.js';
import { defaultSessionFile, SessionStore } from '../src/session/store.js';

let dir: string;
let store: CheckpointStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cake-revert-'));
  store = CheckpointStore.forWorkspace(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One recorded turn that writes the given files, the way a real turn does. */
async function turn(writes: Array<{ path: string; to: string }>): Promise<void> {
  const recorder = store.beginTurn();
  for (const write of writes) await recorder.capture(write.path);
  for (const write of writes) {
    const abs = path.join(dir, write.path);
    await writeFile(abs, write.to, 'utf8');
  }
  await recorder.finish();
  // Turn ids sort by the millisecond they started, and these turns are faster
  // than one.
  await new Promise((resolve) => setTimeout(resolve, 2));
}

describe('revertTurn', () => {
  it('says there is nothing to undo before anyone asks for it', async () => {
    expect(await revertTurn(store, '')).toMatch(/nothing to revert yet/);
    expect(await revertTurn(store, 'list')).toMatch(/no turn has changed a file/);
  });

  it('undoes the newest turn and names each file', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'original\n', 'utf8');
    await turn([{ path: 'a.ts', to: 'rewritten\n' }]);
    await turn([{ path: 'new.ts', to: 'made\n' }]);

    const text = await revertTurn(store, '');
    expect(text).toContain('turn 2 reverted');
    expect(text).toContain('new.ts deleted (it did not exist then)');
    await expect(readFile(path.join(dir, 'new.ts'))).rejects.toThrow();
    expect(await readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('rewritten\n');
  });

  it('undoes the turn it was pointed at by number', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one\n', 'utf8');
    await turn([{ path: 'a.ts', to: 'two\n' }]);
    await turn([{ path: 'b.ts', to: 'made\n' }]);

    expect(await revertTurn(store, '1')).toContain('turn 1 reverted');
    expect(await readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('one\n');
    expect(await readFile(path.join(dir, 'b.ts'), 'utf8')).toBe('made\n');
  });

  it('refuses to swallow a later turn, and says how to override that', async () => {
    await writeFile(path.join(dir, 'a.ts'), 'one\n', 'utf8');
    await turn([{ path: 'a.ts', to: 'two\n' }]);
    await turn([{ path: 'a.ts', to: 'three\n' }]);

    const blocked = await revertTurn(store, '1');
    expect(blocked).toContain('turn 1 was not reverted');
    expect(blocked).toContain('turn 2 has changed the same files');
    expect(blocked).toContain('--force');
    expect(await readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('three\n');

    const forced = await revertTurn(store, '1 --force');
    expect(forced).toContain('turn 1 reverted');
    expect(await readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('one\n');
  });

  it('lists what each turn holds, oldest first', async () => {
    await turn([{ path: 'a.ts', to: 'made\n' }]);
    await turn([
      { path: 'b.ts', to: 'made\n' },
      { path: 'c.ts', to: 'made\n' },
    ]);

    const text = await revertTurn(store, 'list');
    const lines = text.split('\n');
    // The archive folder knows a turn exists; only the session database knows
    // what it was for, and a number nobody can name is a number nobody should undo.
    expect(lines[1]).toMatch(/^\s+1\s+\d\d:\d\d\s+\(no ask recorded\)$/);
    expect(lines[2]).toMatch(/^\s+a\.ts$/);
    expect(lines[3]).toMatch(/^\s+2\s+\d\d:\d\d\s+\(no ask recorded\)$/);
    expect(lines[4]).toMatch(/^\s+b\.ts, c\.ts$/);
  });

  it('names the ask each recorded turn closed', async () => {
    await turn([{ path: 'a.ts', to: 'made\n' }]);
    await turn([{ path: 'b.ts', to: 'made\n' }]);
    const [first, second] = await store.list();
    if (!first || !second) throw new Error('the turns left no archive');

    const text = await revertTurn(
      store,
      'list',
      new Map([
        [first.id, 'rename the parser'],
        [second.id, 'add a test\nand make it pass'],
      ]),
    );
    const lines = text.split('\n');
    expect(lines[1]).toMatch(/^\s+1\s+\d\d:\d\d\s+rename the parser$/);
    expect(lines[2]).toMatch(/^\s+a\.ts$/);
    // A pasted ask reads as one line, and the files stay on the line below it.
    expect(lines[3]).toMatch(/^\s+2\s+\d\d:\d\d\s+add a test and make it pass$/);
    expect(lines[4]).toMatch(/^\s+b\.ts$/);
  });

  it('turns a nonsense argument into instructions rather than a guess', async () => {
    await turn([{ path: 'a.ts', to: 'made\n' }]);
    expect(await revertTurn(store, 'yesterday')).toContain('takes a turn number');
    expect(await revertTurn(store, '9')).toContain('no recorded turn "9"');
    expect(await readFile(path.join(dir, 'a.ts'), 'utf8')).toBe('made\n');
  });

  it('always says what the undo cannot see', async () => {
    const text = await revertTurn(store, 'list');
    expect(text).toContain('changes made by a shell command or an MCP tool are not in this undo');
  });
});

describe('cake --revert', () => {
  /**
   * The entry point is the only place the ask is looked up, and the rest of the
   * list is already proven above, so this runs the real command once: an argument
   * that never reaches `checkpointAsks` would print a column of "no ask recorded"
   * and every other test would stay green.
   */
  it('prints the ask the session database recorded', async () => {
    await turn([{ path: 'a.ts', to: 'made\n' }]);
    const [only] = await store.list();
    if (!only) throw new Error('the turn left no archive');

    const sessions = SessionStore.open(defaultSessionFile(dir));
    const meta = sessions.create({ cwd: dir, provider: 'anthropic', model: 'm' });
    sessions.recordCheckpoint({
      sessionId: meta.id,
      checkpointId: only.id,
      prompt: 'make a.ts from the command line',
      startedAt: only.startedAt,
    });
    sessions.close();

    const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
    const run = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx/esm'), cli, '--revert', 'list'],
      { cwd: dir, encoding: 'utf8', timeout: 120_000 },
    );

    // The exit is the proof: a `--revert` that never reached the archive, or
    // threw on the way, leaves a non-zero status rather than a bad column.
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('make a.ts from the command line');
    expect(run.stdout).toContain('a.ts');
  }, 150_000);
});
