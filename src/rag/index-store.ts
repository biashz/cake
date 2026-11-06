import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type Database, DatabaseSync } from '../session/sqlite.js';
import { toTerms } from './terms.js';

export interface FileRecord {
  path: string;
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface ChunkInput {
  startLine: number;
  endLine: number;
  kind: string;
  text: string;
}

export interface ChunkRecord extends ChunkInput {
  id: number;
  path: string;
}

export interface SearchHit {
  chunk: ChunkRecord;
  score: number;
}

export interface IndexStats {
  files: number;
  chunks: number;
}

interface FileRow {
  path: string;
  mtime_ms: number;
  size: number;
  hash: string;
}

interface ChunkRow {
  id: number;
  path: string;
  start_line: number;
  end_line: number;
  kind: string;
  text: string;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vectors (
    chunk_id INTEGER PRIMARY KEY,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_path ON chunks (path);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_terms USING fts5(terms);
`;

/** Rows written before this table existed; one rebuild puts them in the index. */
const TERMS_VERSION = 'fts.terms.v1';

function toRecord(row: ChunkRow): ChunkRecord {
  return {
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    kind: row.kind,
    text: row.text,
  };
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
  return out;
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function fromBlob(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** SQLite-backed code index: file fingerprints, AST chunks, and normalized vectors. */
export class CodeIndexStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
    if (this.getMeta(TERMS_VERSION) !== '1') this.rebuildTerms();
  }

  /** Index the token text of every chunk already stored, then mark the format current. */
  private rebuildTerms(): void {
    const rows = this.db.prepare('SELECT id, path, text FROM chunks').all() as unknown as Array<
      Pick<ChunkRow, 'id' | 'path' | 'text'>
    >;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM chunks_terms');
      const insert = this.db.prepare('INSERT INTO chunks_terms (rowid, terms) VALUES (?, ?)');
      for (const row of rows) insert.run(row.id, toTerms(row.path, row.text));
      this.setMeta(TERMS_VERSION, '1');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  static open(file: string): CodeIndexStore {
    mkdirSync(path.dirname(file), { recursive: true });
    return new CodeIndexStore(new DatabaseSync(file));
  }

  static inMemory(): CodeIndexStore {
    return new CodeIndexStore(new DatabaseSync(':memory:'));
  }

  files(): Map<string, FileRecord> {
    const rows = this.db.prepare('SELECT * FROM files').all() as unknown as FileRow[];
    return new Map(
      rows.map((row) => [
        row.path,
        { path: row.path, mtimeMs: row.mtime_ms, size: row.size, hash: row.hash },
      ]),
    );
  }

  stats(): IndexStats {
    const files = this.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number };
    const chunks = this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number };
    return { files: files.c, chunks: chunks.c };
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
      )
      .run(key, value, value);
  }

  /** Replace all chunks and vectors for one file; returns the new chunk ids. */
  replaceFile(
    file: FileRecord,
    chunks: ChunkInput[],
    vectors: Float32Array[] | undefined,
  ): number[] {
    if (vectors && vectors.length !== chunks.length) {
      throw new Error(`vector/chunk count mismatch for ${file.path}`);
    }
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)')
        .run(file.path);
      this.db
        .prepare('DELETE FROM chunks_terms WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)')
        .run(file.path);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(file.path);
      this.db
        .prepare(
          `INSERT INTO files (path, mtime_ms, size, hash) VALUES (?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, hash = excluded.hash`,
        )
        .run(file.path, file.mtimeMs, file.size, file.hash);

      const insertChunk = this.db.prepare(
        'INSERT INTO chunks (path, start_line, end_line, kind, text) VALUES (?, ?, ?, ?, ?)',
      );
      const insertTerms = this.db.prepare('INSERT INTO chunks_terms (rowid, terms) VALUES (?, ?)');
      const insertVector = this.db.prepare(
        'INSERT INTO vectors (chunk_id, dim, vec) VALUES (?, ?, ?)',
      );
      const ids: number[] = [];
      chunks.forEach((chunk, index) => {
        const result = insertChunk.run(
          file.path,
          chunk.startLine,
          chunk.endLine,
          chunk.kind,
          chunk.text,
        );
        const id = Number(result.lastInsertRowid);
        ids.push(id);
        insertTerms.run(id, toTerms(file.path, chunk.text));
        const vector = vectors?.[index];
        if (vector) {
          const normalized = normalizeVector(vector);
          insertVector.run(id, normalized.length, toBlob(normalized));
        }
      });
      this.db.exec('COMMIT');
      return ids;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Record a new fingerprint when content is unchanged (same hash). */
  touchFile(file: FileRecord): void {
    this.db
      .prepare('UPDATE files SET mtime_ms = ?, size = ?, hash = ? WHERE path = ?')
      .run(file.mtimeMs, file.size, file.hash, file.path);
  }

  removeFile(filePath: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)')
        .run(filePath);
      this.db
        .prepare('DELETE FROM chunks_terms WHERE rowid IN (SELECT id FROM chunks WHERE path = ?)')
        .run(filePath);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
      this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  clear(): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec(
        'DELETE FROM vectors; DELETE FROM chunks_terms; DELETE FROM chunks; DELETE FROM files; DELETE FROM meta;',
      );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  allChunks(): ChunkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM chunks ORDER BY path, start_line')
      .all() as unknown as ChunkRow[];
    return rows.map(toRecord);
  }

  /**
   * Chunks whose indexed tokens overlap the query, best bm25 first. This only
   * decides which chunks the scorer reads; the score itself is still computed in
   * JS over the real text, so a candidate list cannot change a ranking.
   */
  searchTerms(tokens: string[], limit: number): ChunkRecord[] {
    if (tokens.length === 0 || limit <= 0) return [];
    const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT chunks.* FROM chunks_terms
         JOIN chunks ON chunks.id = chunks_terms.rowid
         WHERE chunks_terms MATCH ?
         ORDER BY bm25(chunks_terms) LIMIT ?`,
      )
      .all(match, limit) as unknown as ChunkRow[];
    return rows.map(toRecord);
  }

  /** Brute-force cosine search over normalized vectors; fine for local codebase sizes. */
  searchVectors(query: Float32Array, limit: number): SearchHit[] {
    const normalizedQuery = normalizeVector(query);
    const rows = this.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.kind, c.text, v.dim, v.vec
         FROM vectors v JOIN chunks c ON c.id = v.chunk_id`,
      )
      .all() as unknown as Array<ChunkRow & { dim: number; vec: Uint8Array }>;

    if (rows.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const row of rows) {
      if (row.dim !== normalizedQuery.length) continue;
      const vector = fromBlob(row.vec);
      let score = 0;
      for (let i = 0; i < vector.length; i++) {
        score += (vector[i] as number) * (normalizedQuery[i] as number);
      }
      hits.push({ chunk: toRecord(row), score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}

export function defaultIndexFile(cwd: string): string {
  return path.join(cwd, '.cake', 'index', 'code.db');
}
