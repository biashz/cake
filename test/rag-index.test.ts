import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/rag/embedder.js';
import { CodeIndexStore, defaultIndexFile } from '../src/rag/index-store.js';
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

describe('searchTerms', () => {
  const chunk = (text: string) => [
    { startLine: 1, endLine: 3, kind: 'function_declaration', text },
  ];

  it('finds a chunk from a camelCase fragment it never stores whole', () => {
    const store = CodeIndexStore.inMemory();
    store.replaceFile(
      { path: 'a.ts', mtimeMs: 1, size: 10, hash: 'h1' },
      chunk('function alphaHandler() {}'),
      undefined,
    );

    // Feeding raw source to FTS5 would index "alphahandler" and miss this query.
    const hits = store.searchTerms(['alpha'], 8);
    expect(hits.map((hit) => hit.path)).toEqual(['a.ts']);
    store.close();
  });

  it('keeps the term index in step with replaces and removes', () => {
    const store = CodeIndexStore.inMemory();
    const file = { path: 'a.ts', mtimeMs: 1, size: 10, hash: 'h1' };
    store.replaceFile(file, chunk('alphaOne'), undefined);

    expect(store.searchTerms(['alpha'], 8)).toHaveLength(1);

    store.replaceFile({ ...file, mtimeMs: 2, hash: 'h2' }, chunk('betaTwo'), undefined);
    expect(store.searchTerms(['alpha'], 8)).toHaveLength(0);
    expect(store.searchTerms(['beta'], 8)).toHaveLength(1);

    store.removeFile('a.ts');
    expect(store.searchTerms(['beta'], 8)).toHaveLength(0);
    store.close();
  });

  it('returns only the chunks that share a token with the query', () => {
    const store = CodeIndexStore.inMemory();
    store.replaceFile(
      { path: 'broad.ts', mtimeMs: 1, size: 10, hash: 'h1' },
      chunk('function alphaHandler() {}'),
      undefined,
    );
    store.replaceFile(
      { path: 'apart.ts', mtimeMs: 1, size: 10, hash: 'h2' },
      chunk('function gammaSession() {}'),
      undefined,
    );

    expect(store.searchTerms(['alpha', 'gamma'], 8).map((hit) => hit.path)).toEqual([
      'broad.ts',
      'apart.ts',
    ]);
    expect(store.searchTerms(['handler'], 8).map((hit) => hit.path)).toEqual(['broad.ts']);
    expect(store.searchTerms(['nothing'], 8)).toEqual([]);
    store.close();
  });
});

describe('term index on disk', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('backfills chunks written before the term table existed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cake-fts-migrate-'));
    tempDirs.push(dir);
    const file = defaultIndexFile(dir);

    const store = CodeIndexStore.open(file);
    store.replaceFile(
      { path: 'a.ts', mtimeMs: 1, size: 10, hash: 'h1' },
      [{ startLine: 1, endLine: 2, kind: 'function_declaration', text: 'alphaOne' }],
      undefined,
    );
    store.close();

    // An index database from before FTS: no term table and no marker.
    const legacy = new DatabaseSync(file);
    legacy.exec('DROP TABLE chunks_terms');
    legacy.prepare("DELETE FROM meta WHERE key = 'fts.terms.v1'").run();
    legacy.close();

    const reopened = CodeIndexStore.open(file);
    try {
      expect(reopened.stats().chunks).toBe(1);
      expect(reopened.searchTerms(['alpha'], 8).map((hit) => hit.path)).toEqual(['a.ts']);
    } finally {
      reopened.close();
    }
  });

  it('keeps exactly one term row per live chunk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cake-fts-hygiene-'));
    tempDirs.push(dir);
    const file = defaultIndexFile(dir);
    const store = CodeIndexStore.open(file);
    const one = (text: string) => [
      { startLine: 1, endLine: 2, kind: 'function_declaration', text },
    ];

    store.replaceFile(
      { path: 'a.ts', mtimeMs: 1, size: 9, hash: 'h1' },
      one('alphaOne'),
      undefined,
    );
    store.replaceFile({ path: 'b.ts', mtimeMs: 1, size: 9, hash: 'h2' }, one('betaTwo'), undefined);
    store.replaceFile(
      { path: 'a.ts', mtimeMs: 2, size: 9, hash: 'h3' },
      one('gammaThree'),
      undefined,
    );
    store.removeFile('b.ts');
    store.close();

    // Rows for chunks that no longer exist stay invisible to a join but keep
    // growing the index, so they are counted here rather than inferred.
    const db = new DatabaseSync(file);
    let chunkRows = 0;
    let termRows = 0;
    try {
      chunkRows = Number((db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c);
      termRows = Number(
        (db.prepare('SELECT COUNT(*) AS c FROM chunks_terms').get() as { c: number }).c,
      );
    } finally {
      db.close();
    }
    expect(chunkRows).toBe(1);
    expect(termRows).toBe(chunkRows);
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
