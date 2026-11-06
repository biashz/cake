import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandCodebaseMention, hasCodebaseMention } from '../src/rag/codebase-mention.js';
import type { Embedder } from '../src/rag/embedder.js';
import { createRagTools } from '../src/rag/tools.js';
import type { CakeTool, ToolContext } from '../src/tools/types.js';

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cake-rag-tools-'));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, 'alpha.ts'),
    'export function alphaHandler() {\n  return "alpha";\n}\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'beta.ts'),
    'export function betaHandler() {\n  return "beta";\n}\n',
    'utf8',
  );
  return dir;
}

function fakeEmbedder(): Embedder {
  return {
    id: 'fake-a',
    async embed(texts) {
      return texts.map((text) => (text.includes('alpha') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
}

function context(cwd: string): ToolContext {
  return { cwd, tasks: [], askPermission: async () => 'allow', log: () => {} };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('RAG tools', () => {
  it('indexes and searches a workspace through tool calls', async () => {
    const cwd = await workspace();
    const [first, second] = createRagTools(fakeEmbedder());
    const indexTool = first as CakeTool<{ force?: boolean }, string>;
    const searchTool = second as CakeTool<{ query: string; limit?: number }, string>;

    const indexed = await indexTool.execute({}, context(cwd));
    expect(indexed).toContain('Indexed 2 chunks from 2 files');

    const output = await searchTool.execute({ query: 'where is alphaHandler' }, context(cwd));
    expect(output).toContain('[hybrid (semantic + lexical)]');
    expect(output).toContain('alpha.ts:1-3');
    expect(output).toContain('alphaHandler');
  });

  it('reflects edits by refreshing changed files before searching', async () => {
    const cwd = await workspace();
    const [first, second] = createRagTools(fakeEmbedder());
    const searchTool = second as CakeTool<{ query: string; limit?: number }, string>;

    await (first as CakeTool<{ force?: boolean }, string>).execute({}, context(cwd));
    await writeFile(
      path.join(cwd, 'alpha.ts'),
      'export function alphaRenamed() {\n  return "alpha";\n}\n',
      'utf8',
    );

    const output = await searchTool.execute({ query: 'alphaRenamed' }, context(cwd));
    expect(output).toContain('alphaRenamed');
    expect(output).not.toContain('alphaHandler');
  });
});

describe('@codebase mention', () => {
  it('detects the mention case-insensitively', () => {
    expect(hasCodebaseMention('where is @codebase used')).toBe(true);
    expect(hasCodebaseMention('see @Codebase')).toBe(true);
    expect(hasCodebaseMention('email me@codebase.dev')).toBe(false);
  });

  it('appends retrieved chunks to the prompt', async () => {
    const cwd = await workspace();
    const result = await expandCodebaseMention('where is @codebase alphaHandler defined?', {
      cwd,
      embedder: fakeEmbedder(),
    });

    expect(result.hits.length).toBeGreaterThan(0);
    // Everything a hit card renders, from the kernel side.
    expect(result.hits[0]).toMatchObject({ path: 'alpha.ts', startLine: 1 });
    expect(typeof result.hits[0]?.score).toBe('number');
    expect(['semantic', 'lexical', 'both']).toContain(result.hits[0]?.via);
    expect(result.text.startsWith('where is')).toBe(true);
    expect(result.text).toContain('<codebase query="where is alphaHandler defined?">');
    expect(result.text).toContain('alpha.ts');
    expect(result.note).toContain('index built on demand');
  });

  it('explains when embeddings are unavailable or the query is empty', async () => {
    const cwd = await workspace();
    const withoutEmbedder = await expandCodebaseMention('find @codebase stuff', { cwd });
    expect(withoutEmbedder.hits).toEqual([]);
    expect(withoutEmbedder.note).toContain('no embedding provider');

    const emptyQuery = await expandCodebaseMention('@codebase', { cwd, embedder: fakeEmbedder() });
    expect(emptyQuery.hits).toEqual([]);
    expect(emptyQuery.note).toContain('needs a query');
  });

  it('leaves prompts without the mention untouched', async () => {
    const result = await expandCodebaseMention('hello world', { cwd: process.cwd() });
    expect(result).toEqual({ text: 'hello world', hits: [] });
  });
});
