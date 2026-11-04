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

async function fixture(rel: string, content: string): Promise<void> {
  const abs = path.join(cwd, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

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

  it('leaves prompts without mentions untouched', async () => {
    const text = 'no mentions here';
    const out = await expandFileReferences(text, cwd);
    expect(out.text).toBe(text);
    expect(out.files).toEqual([]);
    expect(out.missing).toEqual([]);
  });
});
