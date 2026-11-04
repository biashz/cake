import { describe, expect, it } from 'vitest';
import type { ChunkRecord } from '../src/rag/index-store.js';
import { formatResults, mergeResults, tokenize } from '../src/rag/retrieval.js';

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

describe('formatResults', () => {
  it('labels each hit with path, range, kind, and score', () => {
    const text = formatResults(mergeResults(chunks, 'parse config', new Map([[1, 0.9]]), 5));
    expect(text).toContain('src/a.ts:1-3 (function_declaration, score 0.9');
  });

  it('reports an empty result set', () => {
    expect(formatResults([])).toBe('No matching code found.');
  });
});
