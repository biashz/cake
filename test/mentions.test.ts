import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandFileReferences } from '../src/core/mentions.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-mentions-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function fixture(rel: string, content: string | Uint8Array): Promise<void> {
  const abs = path.join(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

// A 1x1 PNG, so an image fixture is the same bytes a screenshot would be.
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

describe('expandFileReferences', () => {
  it('appends mentioned files as blocks', async () => {
    await fixture('notes.txt', 'hello');
    const out = await expandFileReferences('read @notes.txt please', cwd);

    expect(out.files).toEqual(['notes.txt']);
    expect(out.missing).toEqual([]);
    expect(out.text.startsWith('read @notes.txt please')).toBe(true);
    expect(out.text).toContain('<file path="notes.txt">\nhello\n</file>');
  });

  it('dedupes mentions and reports missing paths', async () => {
    await fixture('a.txt', 'A');
    const out = await expandFileReferences('@a.txt @a.txt @nope.txt', cwd);

    expect(out.files).toEqual(['a.txt']);
    expect(out.missing).toEqual(['nope.txt']);
    expect(out.text.match(/<file path="a.txt">/g)).toHaveLength(1);
  });

  it('refuses paths outside the workspace', async () => {
    const out = await expandFileReferences('@../secret.txt', cwd);
    expect(out.files).toEqual([]);
    expect(out.missing).toEqual(['../secret.txt']);
  });

  it('truncates oversized files', async () => {
    await fixture('big.txt', 'y'.repeat(100));
    const out = await expandFileReferences('@big.txt', cwd, 10);
    expect(out.text).toContain('… [truncated]');
  });

  it('sends a @mentioned image as bytes, not as decoded text', async () => {
    await fixture('diagram.png', PNG);
    const out = await expandFileReferences('what does @diagram.png show?', cwd);

    expect(out.files).toEqual(['diagram.png']);
    expect(out.missing).toEqual([]);
    expect(out.text).toBe('what does @diagram.png show?');
    expect(out.images).toHaveLength(1);
    expect(out.images[0]?.startsWith('data:image/png;base64,')).toBe(true);
    // The bug this replaces: UTF-8 decoding of PNG bytes reached the model as junk.
    expect(out.images[0]).not.toContain('\uFFFD');
  });

  it('counts every image kind it recognises, by extension, case-insensitively', async () => {
    await fixture('a/b.PNG', PNG);
    const out = await expandFileReferences('@a/b.PNG', cwd);
    expect(out.images[0]?.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('refuses an image bigger than a turn may carry', async () => {
    await fixture('huge.png', Buffer.alloc(3_000_001, 1));
    const out = await expandFileReferences('@huge.png', cwd);

    expect(out.images).toEqual([]);
    expect(out.missing).toEqual(['huge.png']);
  });

  it('will not inline a binary file that is not an image', async () => {
    await fixture('archive.zip', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 1, 2, 3]));
    const out = await expandFileReferences('@archive.zip', cwd);

    expect(out.text).toBe('@archive.zip');
    expect(out.files).toEqual([]);
    expect(out.missing).toEqual(['archive.zip']);
  });

  it('leaves prompts without mentions untouched', async () => {
    const text = 'no mentions here';
    const out = await expandFileReferences(text, cwd);
    expect(out.text).toBe(text);
    expect(out.files).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.images).toEqual([]);
  });
});
