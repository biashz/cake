import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import type { TaskItem } from '../tools/types.js';
import { type Database, DatabaseSync } from './sqlite.js';

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionInput {
  cwd: string;
  provider: string;
  model: string;
  title?: string;
}

export interface AddUsageInput {
  totalTokens: number;
  costUsd: number;
}

interface SessionRow {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  total_tokens: number;
  cost_usd: number;
  created_at: number;
  updated_at: number;
}

function toMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    provider: row.provider,
    model: row.model,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isTaskItem(value: unknown): value is TaskItem {
  const item = value as Partial<TaskItem> | null;
  return (
    typeof item?.id === 'number' &&
    typeof item.subject === 'string' &&
    (item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed')
  );
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    plan TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS sessions_cwd_updated ON sessions (cwd, updated_at DESC);
`;

/** Project-local session persistence backed by node:sqlite. */
export class SessionStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
    // Databases written before the plan column existed still open.
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'plan')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN plan TEXT NOT NULL DEFAULT '[]'");
    }
  }

  static open(file: string): SessionStore {
    mkdirSync(path.dirname(file), { recursive: true });
    return new SessionStore(new DatabaseSync(file));
  }

  static inMemory(): SessionStore {
    return new SessionStore(new DatabaseSync(':memory:'));
  }

  create(input: CreateSessionInput): SessionMeta {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title ?? '', input.cwd, input.provider, input.model, now, now);
    return {
      id,
      title: input.title ?? '',
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      totalTokens: 0,
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string): SessionMeta | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? toMeta(row) : undefined;
  }

  latest(cwd: string): SessionMeta | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1')
      .get(cwd) as SessionRow | undefined;
    return row ? toMeta(row) : undefined;
  }

  /** Recent sessions for one workspace, newest first. */
  list(cwd: string, limit = 50): SessionMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE cwd = ? ORDER BY updated_at DESC LIMIT ?')
      .all(cwd, limit) as unknown as SessionRow[];
    return rows.map(toMeta);
  }

  messages(id: string): ModelMessage[] {
    const rows = this.db
      .prepare('SELECT payload FROM messages WHERE session_id = ? ORDER BY seq')
      .all(id) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ModelMessage);
  }

  saveMessages(id: string, messages: ModelMessage[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      const insert = this.db.prepare(
        'INSERT INTO messages (session_id, seq, payload) VALUES (?, ?, ?)',
      );
      messages.forEach((message, index) => {
        insert.run(id, index, JSON.stringify(message));
      });
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * The checklist as of the last change, so a resumed session still shows what
   * the model planned. Rows written by other tools are ignored if unreadable.
   */
  plan(id: string): TaskItem[] {
    const row = this.db.prepare('SELECT plan FROM sessions WHERE id = ?').get(id) as
      | { plan: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed: unknown = JSON.parse(row.plan);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isTaskItem);
    } catch {
      return [];
    }
  }

  savePlan(id: string, tasks: readonly TaskItem[]): void {
    this.db.prepare('UPDATE sessions SET plan = ? WHERE id = ?').run(JSON.stringify(tasks), id);
  }

  addUsage(id: string, usage: AddUsageInput): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET total_tokens = total_tokens + ?, cost_usd = cost_usd + ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(usage.totalTokens, usage.costUsd, Date.now(), id);
  }

  /** Set the title from the first user prompt; later calls are no-ops. */
  setTitleIfEmpty(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ? AND title = ?')
      .run(title.slice(0, 80).trim(), id, '');
  }

  updateModel(id: string, provider: string, model: string): void {
    this.db
      .prepare('UPDATE sessions SET provider = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(provider, model, Date.now(), id);
  }

  /** Rename without touching `updated_at`, so renaming does not reorder the list. */
  rename(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ? WHERE id = ?')
      .run(title.slice(0, 80).trim(), id);
  }

  delete(id: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function defaultSessionFile(cwd: string): string {
  return path.join(cwd, '.cake', 'sessions', 'cake.db');
}
