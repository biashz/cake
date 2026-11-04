import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { DEFAULT_IGNORES, toPosix } from '../tools/fs-utils.js';
import { chunkSource, type SourceChunk, supportedExtensions } from './chunker.js';
import type { Embedder } from './embedder.js';
import type { CodeIndexStore, FileRecord } from './index-store.js';

const MAX_FILE_BYTES = 200_000;
const MAX_CHUNKS = 20_000;

export interface IndexOptions {
  cwd: string;
  store: CodeIndexStore;
  embedder: Embedder;
  force?: boolean;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface IndexSummary {
  scannedFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  chunks: number;
  truncated: boolean;
}

const IGNORES = [...DEFAULT_IGNORES, '**/*.min.js', '**/*.min.css'];

function scanPattern(): string {
  const extensions = supportedExtensions().map((extension) => extension.slice(1));
  return `**/*.{${extensions.join(',')}}`;
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Incrementally refresh the code index: unchanged files (same mtime and size) are
 * skipped, changed files are re-chunked and re-embedded, and deleted files are
 * pruned. Re-embeds everything when the embedding model id changes.
 */
export async function indexCodebase(options: IndexOptions): Promise<IndexSummary> {
  const { cwd, store, embedder, force, abortSignal, onProgress } = options;
  const progress = onProgress ?? (() => {});

  if (force) store.clear();
  const previousModel = store.getMeta('embedding');
  if (previousModel && previousModel !== embedder.id) {
    progress(`embedding model changed (${previousModel} -> ${embedder.id}); rebuilding index`);
    store.clear();
  }

  progress('scanning workspace');
  const entries = await fg(scanPattern(), {
    cwd,
    ignore: IGNORES,
    onlyFiles: true,
    dot: false,
    stats: true,
    followSymbolicLinks: false,
  });
  if (abortSignal?.aborted) throw new Error('indexing aborted');

  const known = store.files();
  const seen = new Set<string>();
  const pending: Array<{ file: FileRecord; chunks: SourceChunk[] }> = [];
  let skippedFiles = 0;
  let truncated = false;

  for (const entry of entries) {
    if (abortSignal?.aborted) throw new Error('indexing aborted');
    const relative = toPosix(entry.path);
    seen.add(relative);
    const size = entry.stats?.size ?? 0;
    if (size === 0 || size > MAX_FILE_BYTES) continue;

    const mtimeMs = entry.stats?.mtimeMs ?? 0;
    const existing = known.get(relative);
    if (existing && existing.mtimeMs === mtimeMs && existing.size === size) {
      skippedFiles++;
      continue;
    }

    const content = await readFile(path.join(cwd, relative), 'utf8');
    const hash = hashText(content);
    if (existing && existing.hash === hash) {
      store.touchFile({ path: relative, mtimeMs, size, hash });
      skippedFiles++;
      continue;
    }

    const chunks = await chunkSource(relative, content);
    if (chunks.length === 0) continue;
    pending.push({ file: { path: relative, mtimeMs, size, hash }, chunks });
  }

  let deletedFiles = 0;
  for (const relative of known.keys()) {
    if (!seen.has(relative)) {
      store.removeFile(relative);
      deletedFiles++;
    }
  }

  let chunkCount = 0;
  const writable: typeof pending = [];
  for (const item of pending) {
    if (chunkCount + item.chunks.length > MAX_CHUNKS) {
      truncated = true;
      break;
    }
    chunkCount += item.chunks.length;
    writable.push(item);
  }

  if (chunkCount > 0) {
    progress(`embedding ${chunkCount} chunks from ${writable.length} files`);
    const texts = writable.flatMap((item) => item.chunks.map(toChunkInputText));
    const vectors = await embedder.embed(texts, abortSignal);
    if (vectors.length !== texts.length) {
      throw new Error(`embedding returned ${vectors.length} vectors for ${texts.length} chunks`);
    }

    let cursor = 0;
    for (const item of writable) {
      const slice = vectors.slice(cursor, cursor + item.chunks.length);
      cursor += item.chunks.length;
      store.replaceFile(
        item.file,
        item.chunks,
        slice.map((vector) => Float32Array.from(vector)),
      );
    }
  }

  store.setMeta('embedding', embedder.id);
  const summary: IndexSummary = {
    scannedFiles: entries.length,
    indexedFiles: writable.length,
    skippedFiles,
    deletedFiles,
    chunks: chunkCount,
    truncated,
  };
  progress(
    `indexed ${summary.indexedFiles} files (${summary.chunks} chunks), skipped ${summary.skippedFiles}, deleted ${summary.deletedFiles}`,
  );
  return summary;
}

function toChunkInputText(chunk: SourceChunk): string {
  return `${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.text}`;
}
