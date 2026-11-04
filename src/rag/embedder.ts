import { type EmbeddingModel, embedMany } from 'ai';

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

export interface Embedder {
  /** Stable id used to detect index/embedding-model mismatches. */
  readonly id: string;
  embed(texts: string[], abortSignal?: AbortSignal): Promise<number[][]>;
}

/** Wrap an AI SDK embedding model with batching for large chunk sets. */
export function createEmbedder(
  model: EmbeddingModel,
  id: string = DEFAULT_EMBEDDING_MODEL,
  batchSize = 64,
): Embedder {
  return {
    id,
    async embed(texts, abortSignal) {
      if (texts.length === 0) return [];
      const embeddings: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const values = texts.slice(start, start + batchSize);
        const result = await embedMany({ model, values, abortSignal });
        embeddings.push(...result.embeddings);
      }
      return embeddings;
    },
  };
}
