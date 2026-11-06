import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import type { CostLine } from '../core/cost.js';
import type { CostRow, WorkspaceSpend } from '../core/cost-board.js';
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
  /** Tokens cake had no rate for; counted so their spend is never read as free. */
  unpricedTokens: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateSessionInput {
  cwd: string;
  provider: string;
  model: string;
  title?: string;
}

interface SessionRow {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  total_tokens: number;
  cost_usd: number;
  unpriced_tokens: number;
  created_at: number;
  updated_at: number;
}

interface TurnUsageRow {
  turn: number;
  seq: number;
  occurred_at: number;
  provider: string;
  model: string;
  scope: string;
  agent_type: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  priced: number;
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
    unpricedTokens: row.unpriced_tokens,
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
    -- Tokens with no rate known when they were billed, so $0 is never shown as free.
    unpriced_tokens INTEGER NOT NULL DEFAULT 0,
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
  CREATE TABLE IF NOT EXISTS turn_usage (
    session_id TEXT NOT NULL,
    turn INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    occurred_at INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    scope TEXT NOT NULL,
    agent_type TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    -- 0 when cake had no rate for that model: counted, never priced as free.
    priced INTEGER NOT NULL,
    PRIMARY KEY (session_id, turn, seq)
  );
  CREATE INDEX IF NOT EXISTS sessions_cwd_updated ON sessions (cwd, updated_at DESC);
`;

/** Project-local session persistence backed by node:sqlite. */
export class SessionStore {
  private readonly db: Database;

  private constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
    // Databases written before a column existed still open.
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const additions: [string, string][] = [
      ['plan', "TEXT NOT NULL DEFAULT '[]'"],
      ['unpriced_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, ddl] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${ddl}`);
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
      unpricedTokens: 0,
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

  /**
   * Bill one turn: one row per model that ran, then the session roll-up from the
   * same lines, so the two can never disagree. Turns are numbered per session.
   */
  addTurnUsage(id: string, lines: readonly CostLine[]): void {
    if (lines.length === 0) return;
    const last = this.db
      .prepare('SELECT MAX(turn) AS turn FROM turn_usage WHERE session_id = ?')
      .get(id) as { turn: number | null };
    const turn = (last.turn ?? 0) + 1;
    const now = Date.now();

    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare(
        `INSERT INTO turn_usage
         (session_id, turn, seq, occurred_at, provider, model, scope, agent_type,
          input_tokens, output_tokens, total_tokens, cost_usd, priced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let totalTokens = 0;
      let costUsd = 0;
      let unpricedTokens = 0;
      lines.forEach((line, seq) => {
        insert.run(
          id,
          turn,
          seq,
          now,
          line.model.provider,
          line.model.modelId,
          line.scope,
          line.agentType ?? '',
          line.usage.inputTokens,
          line.usage.outputTokens,
          line.usage.totalTokens,
          line.costUsd,
          line.priced ? 1 : 0,
        );
        totalTokens += line.usage.totalTokens;
        costUsd += line.costUsd;
        if (!line.priced) unpricedTokens += line.usage.totalTokens;
      });
      this.db
        .prepare(
          `UPDATE sessions
           SET total_tokens = total_tokens + ?,
               cost_usd = cost_usd + ?,
               unpriced_tokens = unpriced_tokens + ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(totalTokens, costUsd, unpricedTokens, now, id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Every billed line of one session, oldest turn first. */
  turnUsage(id: string): CostRow[] {
    const rows = this.db
      .prepare('SELECT * FROM turn_usage WHERE session_id = ? ORDER BY turn, seq')
      .all(id) as unknown as TurnUsageRow[];
    return rows.map((row) => ({
      turn: row.turn,
      seq: row.seq,
      occurredAt: row.occurred_at,
      provider: row.provider,
      model: row.model,
      scope: row.scope === 'main' ? 'main' : 'subagent',
      agentType: row.agent_type,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      costUsd: row.cost_usd,
      priced: row.priced === 1,
    }));
  }

  /**
   * Spend across every session of one workspace. Each session carries its own
   * roll-up, so work saved before per-turn rows existed still counts.
   */
  workspaceUsage(cwd: string): WorkspaceSpend {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COALESCE(SUM(unpriced_tokens), 0) AS unpriced_tokens
         FROM sessions WHERE cwd = ?`,
      )
      .get(cwd) as {
      sessions: number;
      total_tokens: number;
      cost_usd: number;
      unpriced_tokens: number;
    };
    return {
      sessions: Number(row.sessions),
      totalTokens: Number(row.total_tokens),
      costUsd: Number(row.cost_usd),
      unpricedTokens: Number(row.unpriced_tokens),
    };
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
      this.db.prepare('DELETE FROM turn_usage WHERE session_id = ?').run(id);
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
