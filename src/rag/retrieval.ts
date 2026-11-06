import type { Embedder } from './embedder.js';
import type { ChunkRecord, CodeIndexStore } from './index-store.js';
import { indexCodebase } from './indexer.js';
import { tokenize } from './terms.js';

export interface RankedChunk {
  chunk: ChunkRecord;
  score: number;
  semantic?: number;
  lexical?: number;
}

/**
 * One retrieved chunk in the shape a view can render: where it came from and why
 * it was chosen. The index itself never reaches the renderer.
 */
export interface CodebaseHit {
  path: string;
  startLine: number;
  endLine: number;
  kind: string;
  /** Blended rank, rounded for display; two hits at 0.81 read as equally good. */
  score: number;
  /** How it matched, so a card says 'meaning' or 'keywords' instead of a bare number. */
  via: 'semantic' | 'lexical' | 'both';
}

export function toHits(results: RankedChunk[]): CodebaseHit[] {
  return results.map(({ chunk, score, semantic, lexical }) => ({
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    kind: chunk.kind,
    score: Math.round(score * 100) / 100,
    via: semantic === undefined ? 'lexical' : (lexical ?? 0) > 0 ? 'both' : 'semantic',
  }));
}

export interface SearchOptions {
  cwd: string;
  store: CodeIndexStore;
  query: string;
  embedder?: Embedder;
  limit?: number;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
  autoIndex?: boolean;
  /** Refresh changed files before searching; the empty-index build happens either way. */
  refresh?: boolean;
}

export interface SearchResult {
  results: RankedChunk[];
  semantic: boolean;
  indexed: boolean;
  note?: string;
}

function lexicalScore(haystackCounts: Map<string, number>, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  let matched = 0;
  let occurrences = 0;
  for (const token of queryTokens) {
    const count = haystackCounts.get(token) ?? 0;
    if (count > 0) {
      matched++;
      occurrences += Math.min(count, 3);
    }
  }
  if (matched === 0) return 0;
  const coverage = matched / queryTokens.length;
  const density = Math.min(1, occurrences / (queryTokens.length * 2));
  return 0.7 * coverage + 0.3 * density;
}

function countTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

/**
 * Merge vector similarity with lexical overlap. Semantic hits dominate when
 * embeddings are available; exact keyword coverage keeps precise matches
 * (identifiers, error strings) from being buried.
 */
export function mergeResults(
  chunks: ChunkRecord[],
  query: string,
  vectorScores: Map<number, number>,
  limit: number,
): RankedChunk[] {
  const queryTokens = [...new Set(tokenize(query))];
  const phrase = query.trim().toLowerCase();
  const useVectors = vectorScores.size > 0;

  const ranked: RankedChunk[] = [];
  for (const chunk of chunks) {
    const lexical = lexicalScore(countTokens(`${chunk.path}\n${chunk.text}`), queryTokens);
    const semantic = vectorScores.get(chunk.id);
    if (semantic === undefined && lexical === 0) continue;
    const base =
      useVectors && semantic !== undefined ? 0.7 * Math.max(0, semantic) + 0.3 * lexical : lexical;
    const exact = phrase.length > 0 && chunk.text.toLowerCase().includes(phrase) ? 0.1 : 0;
    const score = Math.min(1, base + exact);
    if (score <= 0) continue;
    ranked.push({ chunk, score, semantic, lexical });
  }

  ranked.sort((a, b) => b.score - a.score || a.chunk.path.localeCompare(b.chunk.path));
  return ranked.slice(0, limit);
}

export function formatResults(results: RankedChunk[], maxChars = 12_000): string {
  if (results.length === 0) return 'No matching code found.';
  const blocks: string[] = [];
  let used = 0;
  for (const [index, result] of results.entries()) {
    const { chunk } = result;
    const text = chunk.text.length > 2_000 ? `${chunk.text.slice(0, 2_000)}\n…` : chunk.text;
    const block = `${chunk.path}:${chunk.startLine}-${chunk.endLine} (${chunk.kind}, score ${result.score.toFixed(2)})\n${text}`;
    if (used + block.length > maxChars) {
      blocks.push(`… ${results.length - index} more results omitted`);
      break;
    }
    used += block.length;
    blocks.push(block);
  }
  return blocks.join('\n\n');
}

/**
 * Which chunks the scorer reads: everything the vectors found, plus the FTS
 * candidates for the query tokens. A chunk can only score above zero by sharing a
 * token with the query or by having a vector, and both sets are here; the FTS list
 * is capped, and bm25 order means the dropped tail is the weakest keyword match.
 */
function candidates(
  store: CodeIndexStore,
  query: string,
  vectorChunks: ChunkRecord[],
  limit: number,
): ChunkRecord[] {
  const lexical = store.searchTerms([...new Set(tokenize(query))], Math.max(limit * 24, 400));
  const merged: ChunkRecord[] = [];
  const seen = new Set<number>();
  for (const chunk of [...vectorChunks, ...lexical]) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    merged.push(chunk);
  }
  return merged;
}

/** Search the indexed codebase, building or refreshing the index on demand. */
export async function searchCodebase(options: SearchOptions): Promise<SearchResult> {
  const { cwd, store, query, embedder, abortSignal, onProgress } = options;
  const limit = options.limit ?? 8;
  let indexed = false;

  const wasEmpty = store.stats().chunks === 0;
  if (embedder && options.autoIndex !== false && (wasEmpty || options.refresh)) {
    await indexCodebase({ cwd, store, embedder, abortSignal, onProgress });
    indexed = wasEmpty && store.stats().chunks > 0;
  }
  if (store.stats().chunks === 0) {
    return {
      results: [],
      semantic: false,
      indexed,
      note: 'Code index is empty. Run the index_codebase tool first.',
    };
  }

  let semantic = false;
  let note: string | undefined;
  const vectorScores = new Map<number, number>();
  const vectorChunks: ChunkRecord[] = [];
  if (embedder) {
    try {
      const [queryVector] = await embedder.embed([query], abortSignal);
      if (queryVector) {
        for (const hit of store.searchVectors(Float32Array.from(queryVector), limit * 3)) {
          vectorScores.set(hit.chunk.id, hit.score);
          vectorChunks.push(hit.chunk);
        }
        semantic = true;
      }
    } catch (err) {
      note = `semantic search unavailable: ${(err as Error).message}`;
    }
  } else {
    note = 'embeddings not configured; lexical search only';
  }

  const results = mergeResults(
    candidates(store, query, vectorChunks, limit),
    query,
    vectorScores,
    limit,
  );
  return { results, semantic, indexed, note };
}
