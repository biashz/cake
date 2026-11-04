import { z } from 'zod';
import type { CakeTool, ToolContext } from '../tools/types.js';
import type { Embedder } from './embedder.js';
import { CodeIndexStore, defaultIndexFile } from './index-store.js';
import { indexCodebase } from './indexer.js';
import { formatResults, searchCodebase } from './retrieval.js';

const indexSchema = z.object({
  force: z.boolean().optional().describe('Rebuild the whole index instead of refreshing it'),
});

const searchSchema = z.object({
  query: z.string().min(1).describe('What to look for: identifiers, error text, or a question'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Maximum chunks to return (default 8)'),
});

type IndexArgs = z.infer<typeof indexSchema>;
type SearchArgs = z.infer<typeof searchSchema>;

function withStore<T>(ctx: ToolContext, run: (store: CodeIndexStore) => Promise<T>): Promise<T> {
  const store = CodeIndexStore.open(defaultIndexFile(ctx.cwd));
  return run(store).finally(() => store.close());
}

/** Semantic + lexical tools available when an embedding model is configured. */
export function createRagTools(embedder: Embedder): CakeTool[] {
  const indexTool: CakeTool<IndexArgs, string> = {
    name: 'index_codebase',
    description:
      'Build or refresh the semantic code index. Only changed files are re-embedded; pass force to rebuild from scratch.',
    permission: 'read',
    inputSchema: indexSchema,
    summarize: (args) => (args.force ? 'rebuild code index' : 'refresh code index'),
    matchTarget: () => '.cake/index',
    execute: (args, ctx) =>
      withStore(ctx, async (store) => {
        const summary = await indexCodebase({
          cwd: ctx.cwd,
          store,
          embedder,
          force: args.force,
          onProgress: ctx.log,
        });
        const truncated = summary.truncated ? ' (chunk cap reached; remaining files skipped)' : '';
        return `Indexed ${summary.chunks} chunks from ${summary.indexedFiles} files; skipped ${summary.skippedFiles}, deleted ${summary.deletedFiles}${truncated}.`;
      }),
  };

  const searchTool: CakeTool<SearchArgs, string> = {
    name: 'search_code',
    description:
      'Search the codebase by meaning and keywords. Use it to locate definitions, usages, and behavior before reading files.',
    permission: 'read',
    inputSchema: searchSchema,
    summarize: (args) => args.query,
    matchTarget: (args) => args.query,
    execute: (args, ctx) =>
      withStore(ctx, async (store) => {
        const result = await searchCodebase({
          cwd: ctx.cwd,
          store,
          query: args.query,
          embedder,
          limit: args.limit,
          refresh: true,
          onProgress: ctx.log,
        });
        const mode = result.semantic ? 'hybrid (semantic + lexical)' : 'lexical';
        const notes = [result.indexed ? 'index built on demand' : '', result.note ?? '']
          .filter(Boolean)
          .join('; ');
        const header = notes ? `[${mode}] ${notes}` : `[${mode}]`;
        return `${header}\n\n${formatResults(result.results)}`;
      }),
  };

  return [indexTool, searchTool] as CakeTool[];
}
