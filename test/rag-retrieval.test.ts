import { describe, expect, it } from 'vitest';
import { type ChunkRecord, CodeIndexStore } from '../src/rag/index-store.js';
import {
  formatResults,
  mergeResults,
  type RankedChunk,
  searchCodebase,
  toHits,
} from '../src/rag/retrieval.js';
import { tokenize } from '../src/rag/terms.js';

const chunks: ChunkRecord[] = [
  {
    id: 1,
    path: 'src/a.ts',
    startLine: 1,
    endLine: 3,
    kind: 'function_declaration',
    text: 'function parseConfig(raw: string) {\n  return JSON.parse(raw);\n}',
  },
  {
    id: 2,
    path: 'src/b.ts',
    startLine: 1,
    endLine: 1,
    kind: 'lexical_declaration',
    text: 'const unrelatedValue = 1;',
  },
];

describe('tokenize', () => {
  it('splits camelCase and snake_case and drops stopwords', () => {
    expect(tokenize('readFileSync path_to_file')).toEqual([
      'read',
      'file',
      'sync',
      'path',
      'to',
      'file',
    ]);
    expect(tokenize('the function returns this value')).toEqual(['returns', 'value']);
  });
});

describe('mergeResults', () => {
  it('combines semantic and lexical signals', () => {
    const ranked = mergeResults(chunks, 'parse config', new Map([[1, 0.9]]), 5);
    expect(ranked[0]?.chunk.id).toBe(1);
    expect(ranked[0]?.semantic).toBeCloseTo(0.9);
    expect(ranked[0]?.score).toBeGreaterThan(0.5);
  });

  it('falls back to lexical scoring when no vectors exist', () => {
    const ranked = mergeResults(chunks, 'parseConfig', new Map(), 5);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.chunk.id).toBe(1);
    expect(ranked[0]?.semantic).toBeUndefined();
  });

  it('boosts chunks containing the exact phrase', () => {
    const [hit] = mergeResults(chunks, 'unrelatedValue', new Map(), 5);
    expect(hit?.chunk.id).toBe(2);
    expect(hit?.lexical).toBeDefined();
  });
});

function ranked(over: Omit<RankedChunk, 'chunk'>): RankedChunk {
  return { chunk: chunks[0] as ChunkRecord, ...over };
}

describe('toHits', () => {
  it('names how each hit matched, so a card reads as meaning or keywords', () => {
    const [meaningOnly, keywordsOnly, both] = toHits([
      ranked({ score: 0.9, semantic: 0.9 }),
      ranked({ score: 0.4, lexical: 0.4 }),
      ranked({ score: 0.95, semantic: 0.9, lexical: 0.4 }),
    ]);
    expect(meaningOnly?.via).toBe('semantic');
    expect(keywordsOnly?.via).toBe('lexical');
    expect(both?.via).toBe('both');
  });

  it('treats a zero lexical score as no keyword match', () => {
    expect(toHits([ranked({ score: 0.9, semantic: 0.9, lexical: 0 })])[0]?.via).toBe('semantic');
  });

  it('carries the location and a display-rounded score', () => {
    const [hit] = toHits([ranked({ score: 0.81234, semantic: 0.9 })]);
    expect(hit).toMatchObject({ path: 'src/a.ts', startLine: 1, endLine: 3, score: 0.81 });
  });
});

describe('formatResults', () => {
  it('labels each hit with path, range, kind, and score', () => {
    const text = formatResults(mergeResults(chunks, 'parse config', new Map([[1, 0.9]]), 5));
    expect(text).toContain('src/a.ts:1-3 (function_declaration, score 0.9');
  });

  it('reports an empty result set', () => {
    expect(formatResults([])).toBe('No matching code found.');
  });
});

describe('searchCodebase candidates', () => {
  /** A corpus big enough that scanning it and indexing it must agree, not just not crash. */
  function corpus(extra: Array<{ path: string; text: string }>): CodeIndexStore {
    const store = CodeIndexStore.inMemory();
    const fillers = Array.from({ length: 60 }, (_, index) => {
      // Insertion order deliberately differs from path order: bm25 walks rowids and
      // the scorer walks paths, so a candidate ceiling that is too low shows up here.
      const slot = (index * 29) % 60;
      return {
        path: `src/f${String(slot).padStart(3, '0')}.ts`,
        text: 'export const configValue = 1;',
      };
    });
    const files = [...extra, ...fillers];
    files.forEach((file, index) => {
      store.replaceFile(
        { path: file.path, mtimeMs: index, size: 10, hash: `h${index}` },
        [{ startLine: 1, endLine: 2, kind: 'lexical_declaration', text: file.text }],
        [Float32Array.from([1, 0])],
      );
    });
    return store;
  }

  it('ranks the same from FTS candidates as from scanning every chunk', async () => {
    const store = corpus([
      { path: 'src/parse.ts', text: 'function parseConfig(raw) { return raw; }' },
    ]);
    const query = 'parse config raw';

    const scanned = mergeResults(store.allChunks(), query, new Map(), 8);
    const indexed = await searchCodebase({
      cwd: process.cwd(),
      store,
      query,
      autoIndex: false,
      limit: 8,
    });

    expect(scanned.length).toBe(8);
    expect(indexed.results.map((result) => [result.chunk.path, result.score])).toEqual(
      scanned.map((result) => [result.chunk.path, result.score]),
    );
    expect(indexed.results[0]?.chunk.path).toBe('src/parse.ts');
    store.close();
  });

  it('keeps semantic hits that share no keyword with the query', async () => {
    const store = corpus([{ path: 'src/gamma.ts', text: 'export const gammaThing = 1;' }]);
    const indexed = await searchCodebase({
      cwd: process.cwd(),
      store,
      query: 'delta',
      autoIndex: false,
      limit: 4,
      embedder: {
        id: 'flat',
        async embed(texts) {
          return texts.map(() => [1, 0]);
        },
      },
    });

    // Nothing matches 'delta' as a keyword, so only the vector candidates survive.
    expect(indexed.semantic).toBe(true);
    expect(indexed.results.length).toBeGreaterThan(0);
    expect(indexed.results.every((result) => result.lexical === 0)).toBe(true);
    store.close();
  });
});
