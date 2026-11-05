import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desktopStateFile, loadDesktopState, saveDesktopState } from '../src/desktop/state.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cake-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('desktop state', () => {
  it('returns an empty state when the file does not exist', async () => {
    expect(await loadDesktopState(desktopStateFile(dir))).toEqual({});
  });

  it('round-trips the last workspace', async () => {
    const file = desktopStateFile(dir);
    await saveDesktopState(file, { lastWorkspace: 'D:/work/demo' });

    expect(await loadDesktopState(file)).toEqual({ lastWorkspace: 'D:/work/demo' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ lastWorkspace: 'D:/work/demo' });
  });

  it('ignores corrupt or unexpected files instead of failing startup', async () => {
    const file = desktopStateFile(dir);
    await writeFile(file, '{not json', 'utf8');
    expect(await loadDesktopState(file)).toEqual({});

    await writeFile(file, JSON.stringify({ lastWorkspace: 42 }), 'utf8');
    expect(await loadDesktopState(file)).toEqual({});
  });
});
