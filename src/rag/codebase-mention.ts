import type { Embedder } from './embedder.js';
import { CodeIndexStore, defaultIndexFile } from './index-store.js';
import { formatResults, searchCodebase } from './retrieval.js';

const CODEBASE_RE = /(^|\s)@codebase\b/gi;

export interface CodebaseMentionOptions {
  cwd: string;
  embedder?: Embedder;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CodebaseExpansion {
  /** Input with `@codebase` stripped and the retrieved context appended. */
  text: string;
  /** Number of code chunks injected as context. */
  results: number;
  note?: string;
}

export function hasCodebaseMention(input: string): boolean {
  return /(^|\s)@codebase\b/i.test(input);
}

function queryFrom(input: string): string {
  return input.replace(CODEBASE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Replace an `@codebase` mention with retrieved code context. The store is opened
 * lazily and the index is built on first use, so the mention works without a
 * separate indexing step.
 */
export async function expandCodebaseMention(
  input: string,
  options: CodebaseMentionOptions,
): Promise<CodebaseExpansion> {
  const query = queryFrom(input);
  if (!hasCodebaseMention(input)) return { text: input, results: 0 };
  if (!query)
    return { text: query, results: 0, note: '@codebase needs a query, e.g. "where is X"' };
  if (!options.embedder) {
    return {
      text: query,
      results: 0,
      note: '@codebase is unavailable: no embedding provider configured',
    };
  }

  const store = CodeIndexStore.open(defaultIndexFile(options.cwd));
  try {
    const result = await searchCodebase({
      cwd: options.cwd,
      store,
      query,
      embedder: options.embedder,
      abortSignal: options.abortSignal,
      refresh: true,
      onProgress: options.onProgress,
    });
    if (result.results.length === 0) {
      return {
        text: query,
        results: 0,
        note: result.note ?? 'no code matched the @codebase query',
      };
    }
    const block = `<codebase query="${query.replace(/"/g, '&quot;')}">\n${formatResults(result.results)}\n</codebase>`;
    const notes = [result.indexed ? 'index built on demand' : '', result.note ?? '']
      .filter(Boolean)
      .join('; ');
    return {
      text: `${query}\n\n${block}`,
      results: result.results.length,
      ...(notes ? { note: notes } : {}),
    };
  } finally {
    store.close();
  }
}
