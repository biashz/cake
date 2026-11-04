import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/rag/embedder.js';
import { CodeIndexStore } from '../src/rag/index-store.js';
import { indexCodebase } from '../src/rag/indexer.js';

const tempDirs: string[] = [];

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cake-rag-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function fakeEmbedder(id = 'fake-a'): Embedder {
  return {
    id,
    async embed(texts) {
      return texts.map((text) => (text.includes('alpha') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('CodeIndexStore', () => {
  it('replaces chunks per file and drops stale vectors', () => {
    const store = CodeIndexStore.inMemory();
    const file = { path: 'a.ts', mtimeMs: 1, size: 10, hash: 'h1' };
    const first = store.replaceFile(
      file,
      [{ startLine: 1, endLine: 2, kind: 'function_declaration', text: 'alpha' }],
      [Float32Array.from([1, 1])],
    );

    expect(store.stats()).toEqual({ files: 1, chunks: 1 });
    expect(store.searchVectors(Float32Array.from([1, 0]), 5)).toHaveLength(1);

    const second = store.replaceFile(
      { ...file, mtimeMs: 2, hash: 'h2' },
      [{ startLine: 1, endLine: 2, kind: 'class_declaration', text: 'beta' }],
      [Float32Array.from([0, 1])],
    );

    expect(second).not.toEqual(first);
    expect(store.stats()).toEqual({ files: 1, chunks: 1 });
    const hits = store.searchVectors(Float32Array.from([0, 1]), 5);
    expect(hits[0]?.chunk.kind).toBe('class_declaration');
    expect(hits[0]?.score).toBeCloseTo(1);

    store.removeFile('a.ts');
    expect(store.stats()).toEqual({ files: 0, chunks: 0 });
    store.close();
  });
});

describe('indexCodebase', () => {
  it('indexes files, then skips unchanged files and prunes deleted ones', async () => {
    const cwd = await workspace({
      'alpha.ts': 'export function alphaOne() {\n  return "alpha";\n}\n',
      'beta.ts': 'export function betaOne() {\n  return "beta";\n}\n',
    });
    const store = CodeIndexStore.inMemory();
    const embedder = fakeEmbedder();

    const first = await indexCodebase({ cwd, store, embedder });
    expect(first.indexedFiles).toBe(2);
    expect(first.skippedFiles).toBe(0);
    expect(first.chunks).toBe(2);
    expect(store.getMeta('embedding')).toBe('fake-a');

    const second = await indexCodebase({ cwd, store, embedder });
    expect(second.indexedFiles).toBe(0);
    expect(second.skippedFiles).toBe(2);

    await writeFile(
      path.join(cwd, 'alpha.ts'),
      'export function alphaTwo() {\n  return "alpha rewritten";\n}\n',
      'utf8',
    );
    const third = await indexCodebase({ cwd, store, embedder });
    expect(third.indexedFiles).toBe(1);
    expect(third.skippedFiles).toBe(1);
    expect(store.allChunks().some((chunk) => chunk.text.includes('alphaTwo'))).toBe(true);

    await unlink(path.join(cwd, 'beta.ts'));
    const fourth = await indexCodebase({ cwd, store, embedder });
    expect(fourth.deletedFiles).toBe(1);
    expect(store.stats().files).toBe(1);

    store.close();
  });

  it('rebuilds when the embedding model changes or force is set', async () => {
    const cwd = await workspace({
      'alpha.ts': 'export function alphaOne() {\n  return "alpha";\n}\n',
    });
    const store = CodeIndexStore.inMemory();

    await indexCodebase({ cwd, store, embedder: fakeEmbedder('fake-a') });
    const changed = await indexCodebase({ cwd, store, embedder: fakeEmbedder('fake-b') });
    expect(changed.indexedFiles).toBe(1);

    const forced = await indexCodebase({
      cwd,
      store,
      embedder: fakeEmbedder('fake-b'),
      force: true,
    });
    expect(forced.indexedFiles).toBe(1);

    store.close();
  });
});
