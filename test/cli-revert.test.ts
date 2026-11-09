import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revertTurn } from '../src/cli/revert.js';
import { CheckpointStore } from '../src/core/checkpoints.js';

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
    expect(lines[1]).toMatch(/^\s+1\s+\d\d:\d\d\s+a\.ts$/);
    expect(lines[2]).toMatch(/^\s+2\s+\d\d:\d\d\s+b\.ts, c\.ts$/);
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
