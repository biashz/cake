import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointStore, type CheckpointTurn } from '../src/core/checkpoints.js';

let dir: string;
let store: CheckpointStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cake-checkpoints-'));
  store = CheckpointStore.forWorkspace(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function bytes(rel: string): Promise<Buffer> {
  return readFile(path.join(dir, rel));
}

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

/** Run a turn the way the tool wrapper does: capture each path, then change it. */
async function turnThatWrites(
  writes: Array<{ path: string; to: string | Buffer }>,
  target: CheckpointStore = store,
): Promise<CheckpointTurn> {
  const turn = target.beginTurn();
  for (const write of writes) await turn.capture(write.path);
  for (const write of writes) await put(write.path, write.to);
  const manifest = await turn.finish();
  if (!manifest) throw new Error('turn wrote nothing to the checkpoint store');
  return manifest;
}

describe('capture', () => {
  it('keeps the bytes that were there, not a text reading of them', async () => {
    // 0xff 0xfe and an invalid UTF-8 sequence: a store that round-tripped
    // through utf8 would corrupt both, so the check is byte for byte.
    const original = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0xc3, 0x28]);
    await put('blob.bin', original);
    const turn = await turnThatWrites([{ path: 'blob.bin', to: 'junk' }]);

    const report = await store.rewind(turn.id);
    if (!report?.applied) throw new Error('rewind did not apply');
    expect((await bytes('blob.bin')).equals(original)).toBe(true);
  });

  it('puts a file the turn created back to not existing', async () => {
    const turn = await turnThatWrites([{ path: 'src/new.ts', to: 'export const a = 1;' }]);
    expect(await exists('src/new.ts')).toBe(true);

    const report = await store.rewind(turn.id);
    expect(report?.changes).toEqual([{ path: 'src/new.ts', action: 'deleted' }]);
    expect(await exists('src/new.ts')).toBe(false);
  });

  it('records how the turn found the file, not how each edit left it', async () => {
    await put('a.ts', 'one');
    const turn = store.beginTurn();
    await turn.capture('a.ts');
    await put('a.ts', 'two');
    await turn.capture('a.ts');
    await put('a.ts', 'three');
    const manifest = await turn.finish();
    if (!manifest) throw new Error('nothing was recorded');

    const report = await store.rewind(manifest.id);
    expect(report?.changes).toEqual([{ path: 'a.ts', action: 'restored' }]);
    expect((await bytes('a.ts')).toString('utf8')).toBe('one');
  });

  it('leaves cake state out of the archive', async () => {
    await put('.cake/sessions/cake.db', 'sessions');
    const turn = store.beginTurn();
    await turn.capture('.cake/sessions/cake.db');
    await turn.capture('.cake/checkpoints/blobs/deadbeef');
    await put('.cake/sessions/cake.db', 'overwritten');
    expect(await turn.finish()).toBeUndefined();
    expect((await bytes('.cake/sessions/cake.db')).toString('utf8')).toBe('overwritten');
  });

  it('refuses a path that walks out of the workspace', async () => {
    const turn = store.beginTurn();
    await turn.capture('../outside.ts');
    await turn.capture(path.join(dir, '..', 'outside.ts'));
    expect(await turn.finish()).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('will not call an unwritable store a file that did not exist', async () => {
    // The blobs directory is a plain file, so every copy fails. Reading the
    // failure as "nothing was here" would make rewind delete a file the turn
    // had only edited.
    await put('a.ts', 'one');
    await mkdir(path.dirname(path.join(dir, '.cake', 'checkpoints', 'blobs')), { recursive: true });
    await writeFile(path.join(dir, '.cake', 'checkpoints', 'blobs'), 'in the way');
    const turn = store.beginTurn();
    await turn.capture('a.ts');
    await put('a.ts', 'two');
    const manifest = await turn.finish();
    if (!manifest) throw new Error('the turn left no manifest');

    const report = await store.rewind(manifest.id);
    expect(report?.changes).toEqual([
      { path: 'a.ts', action: 'left', note: 'no copy was kept: unreadable' },
    ]);
    expect((await bytes('a.ts')).toString('utf8')).toBe('two');
  });

  it('says so when a file is too big to keep, instead of pretending it can undo it', async () => {
    // One byte over the cap: the boundary is the thing under test.
    await put('big.bin', Buffer.alloc(8 * 1024 * 1024 + 1, 7));
    const turn = await turnThatWrites([{ path: 'big.bin', to: 'small now' }]);

    const report = await store.rewind(turn.id);
    expect(report?.changes).toEqual([
      { path: 'big.bin', action: 'left', note: 'no copy was kept: too large' },
    ]);
    expect((await bytes('big.bin')).toString('utf8')).toBe('small now');
  });

  it('records nothing for a turn that touched no file', async () => {
    expect(await store.beginTurn().finish()).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

describe('rewind', () => {
  it('plans the undo before it performs it', async () => {
    await put('a.ts', 'one');
    const turn = await turnThatWrites([{ path: 'a.ts', to: 'two' }]);

    const plan = await store.plan(turn.id);
    expect(plan?.applied).toBe(false);
    expect(plan?.changes).toEqual([{ path: 'a.ts', action: 'restored' }]);
    expect((await bytes('a.ts')).toString('utf8')).toBe('two');
  });

  it('refuses to erase a later turn that changed the same file', async () => {
    await put('a.ts', 'one');
    const first = await turnThatWrites([{ path: 'a.ts', to: 'two' }]);
    const second = await turnThatWrites([{ path: 'a.ts', to: 'three' }]);

    const blocked = await store.rewind(first.id);
    expect(blocked?.applied).toBe(false);
    expect(blocked?.overwrittenBy).toEqual([second.id]);
    expect((await bytes('a.ts')).toString('utf8')).toBe('three');

    const forced = await store.rewind(first.id, { force: true });
    expect(forced?.applied).toBe(true);
    expect((await bytes('a.ts')).toString('utf8')).toBe('one');
  });

  it('undoes only the turn it was pointed at', async () => {
    const older = await turnThatWrites([{ path: 'a.ts', to: 'two' }]);
    const newer = await turnThatWrites([{ path: 'b.ts', to: 'made here' }]);
    expect(older.id).not.toBe(newer.id);

    await store.rewind(newer.id);
    expect((await bytes('a.ts')).toString('utf8')).toBe('two');
    expect(await exists('b.ts')).toBe(false);
  });

  it('deletes a created file even when its directory is already gone', async () => {
    const turn = await turnThatWrites([{ path: 'deep/nest/a.ts', to: 'made' }]);
    await rm(path.join(dir, 'deep'), { recursive: true, force: true });

    const report = await store.rewind(turn.id);
    expect(report?.changes[0]?.action).toBe('deleted');
    expect(await exists('deep/nest/a.ts')).toBe(false);
  });
});

/** Turn ids sort by the millisecond they started; a test that makes several
 *  turns in a row would otherwise order them by their random suffix. */
const spaceOut = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

describe('numbering', () => {
  it('numbers the turns oldest first, the way a transcript does', async () => {
    const first = await turnThatWrites([{ path: 'a.ts', to: 'made' }]);
    await spaceOut();
    const second = await turnThatWrites([{ path: 'b.ts', to: 'made' }]);
    await spaceOut();
    const third = await turnThatWrites([{ path: 'c.ts', to: 'made' }]);

    expect((await store.resolve(1))?.id).toBe(first.id);
    expect((await store.resolve('2'))?.id).toBe(second.id);
    expect((await store.resolve(-1))?.id).toBe(third.id);
    expect((await store.resolve('-3'))?.id).toBe(first.id);
    expect((await store.resolve(undefined))?.id).toBe(third.id);
    expect((await store.lastTurn())?.id).toBe(third.id);
    expect(await store.resolve(4)).toBeUndefined();
    expect(await store.resolve(0)).toBeUndefined();
    expect((await store.resolve(third.id))?.id).toBe(third.id);
  });

  it('names each turn by what it holds, so a revert can be chosen', async () => {
    const turn = await turnThatWrites([
      { path: 'x.ts', to: 'made' },
      { path: 'y.ts', to: 'made' },
    ]);
    const described = await store.describe();
    expect(described).toHaveLength(1);
    expect(described[0]?.turn.id).toBe('1');
    expect(described[0]?.turn.startedAt).toBe(turn.startedAt);
    expect(described[0]?.paths).toEqual(['x.ts', 'y.ts']);
  });
});

describe('prune', () => {
  it('keeps the newest turns and drops the older manifests', async () => {
    const small = CheckpointStore.forWorkspace(dir, { keepTurns: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const turn = await turnThatWrites([{ path: `f${i}.ts`, to: `content ${i}` }], small);
      ids.push(turn.id);
      await spaceOut();
    }
    const turns = await small.list();
    expect(turns.map((turn) => turn.id)).toEqual(ids.slice(3));
    // Undo goes away; the files themselves are not touched.
    expect(await exists('f0.ts')).toBe(true);
  });

  it('keeps fifty turns by default', () => {
    expect(CheckpointStore.forWorkspace(dir).keepTurns).toBe(50);
  });

  it('deletes a blob nothing references, but not one a running turn just wrote', async () => {
    await put('a.ts', 'one');
    const turn = await turnThatWrites([{ path: 'a.ts', to: 'two' }]);
    const live = turn.entries[0]?.before;
    if (!live) throw new Error('the turn stored no before-image');
    const orphan = 'f'.repeat(64);
    const fresh = 'e'.repeat(64);
    const blobs = path.join(dir, '.cake', 'checkpoints', 'blobs');
    await writeFile(path.join(blobs, orphan), 'gone');
    await writeFile(path.join(blobs, fresh), 'referenced by a turn with no manifest yet');
    // Both orphans and the live blob are aged, so the grace window is visibly
    // not the reason the live one survives and the fresh one does.
    const longAgo = new Date(Date.now() - 60_000_000);
    await utimes(path.join(blobs, live), longAgo, longAgo);
    await utimes(path.join(blobs, orphan), longAgo, longAgo);

    await store.prune();
    const kept = await readdir(blobs);
    expect(kept).toContain(live);
    expect(kept).toContain(fresh);
    expect(kept).not.toContain(orphan);
  });
});
