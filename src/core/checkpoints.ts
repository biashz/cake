import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Undo for the files cake changes. Every write tool captures what was at its
 * path before it ran, so a turn that went wrong can be put back — including a
 * file that did not exist yet, which rewind deletes.
 */

/** Past this, a before-image costs more disk than it is worth; the file is left out. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Nobody rewinds a hundred turns back, and an unbounded archive of old files is its own hazard. */
const KEEP_TURNS = 50;
/** A blob a concurrent turn re-referenced is touched, so a prune younger than this is still in use. */
const PRUNE_GRACE_MS = 5 * 60 * 1000;

/** What one turn did to one path. */
export interface CheckpointEntry {
  /** Workspace-relative, posix-separated. */
  path: string;
  /** Blob of the bytes that were there before this turn, or null when the turn created it. */
  before: string | null;
  /** Set when no copy could be kept; rewind leaves such a file alone rather than guess. */
  skipped?: 'too large' | 'unreadable';
}

export interface CheckpointTurn {
  /** Sortable: epoch milliseconds, then randomness for two turns in the same instant. */
  id: string;
  startedAt: number;
  entries: CheckpointEntry[];
}

/** What rewind would do, computed before it does anything. */
export interface RewindChange {
  path: string;
  action: 'restored' | 'deleted' | 'left' | 'failed';
  /** Why a file was not touched, or how touching it went wrong. */
  note?: string;
}

export interface RewindReport {
  turn: CheckpointTurn;
  changes: RewindChange[];
  /** Later turns that changed a path this one is about to put back — the clobbered work. */
  overwrittenBy: string[];
  /** False when the conflicts stopped rewind from touching anything. */
  applied: boolean;
}

/** The per-turn half of the store, handed to tools through the context. */
export interface TurnRecorder {
  capture(target: string): Promise<void>;
  /** Writes the manifest for what was captured; nothing recorded leaves no trace. */
  finish(): Promise<CheckpointTurn | undefined>;
}

function toPosix(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

/**
 * Workspace-relative and inside cake's own state, and it is not a path we can
 * checkpoint: `.cake/` holds the session database and this store, so rewinding
 * a turn would rewind cake's memory of the turn.
 */
function checkpointable(cwd: string, target: string): string | undefined {
  const abs = path.resolve(cwd, target);
  const rel = path.relative(cwd, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined;
  }
  const posix = toPosix(rel);
  if (posix === '.cake' || posix.startsWith('.cake/')) return undefined;
  return posix;
}

function turnId(now: number): string {
  return `${String(now).padStart(13, '0')}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export interface CheckpointStoreOptions {
  /** How many turns of undo to keep; older manifests and their blobs are dropped. */
  keepTurns?: number;
}

export class CheckpointStore {
  readonly keepTurns: number;

  private constructor(
    readonly cwd: string,
    readonly root: string,
    keepTurns: number,
  ) {
    this.keepTurns = keepTurns;
  }

  static forWorkspace(cwd: string, options: CheckpointStoreOptions = {}): CheckpointStore {
    return new CheckpointStore(
      cwd,
      path.join(cwd, '.cake', 'checkpoints'),
      options.keepTurns ?? KEEP_TURNS,
    );
  }

  private get turnsDir(): string {
    return path.join(this.root, 'turns');
  }

  private get blobsDir(): string {
    return path.join(this.root, 'blobs');
  }

  private manifestFile(id: string): string {
    return path.join(this.turnsDir, `${id}.json`);
  }

  private blobFile(hash: string): string {
    return path.join(this.blobsDir, hash);
  }

  /** Start recording one turn. Safe to call for several turns at once. */
  beginTurn(): TurnRecorder {
    return new TurnCheckpoint(this);
  }

  /** Recorded turns, oldest first — the order a transcript numbers them in. */
  async list(): Promise<CheckpointTurn[]> {
    let names: string[];
    try {
      names = await readdir(this.turnsDir);
    } catch {
      return [];
    }
    const turns: CheckpointTurn[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(
          await readFile(path.join(this.turnsDir, name), 'utf8'),
        ) as CheckpointTurn;
        if (typeof parsed?.id === 'string' && Array.isArray(parsed.entries)) turns.push(parsed);
      } catch {
        // A manifest written before it crashes is not worth losing the rest over.
      }
    }
    return turns;
  }

  /** The most recent recorded turn, if any. */
  async lastTurn(): Promise<CheckpointTurn | undefined> {
    const turns = await this.list();
    return turns[turns.length - 1];
  }

  async get(id: string): Promise<CheckpointTurn | undefined> {
    return (await this.list()).find((turn) => turn.id === id);
  }

  /**
   * Resolve a human-facing index — the numbering `/revert` prints — back to a
   * turn. Accepts 1-based (oldest first) and `-n` for n turns ago, so `/revert -1`
   * and a bare `/revert` mean the same thing.
   */
  async resolve(index: string | number | undefined): Promise<CheckpointTurn | undefined> {
    const turns = await this.list();
    if (turns.length === 0) return undefined;
    if (index === undefined) return turns[turns.length - 1];
    const text = String(index).trim();
    if (text === '') return turns[turns.length - 1];
    if (text.startsWith('-')) {
      const back = Number(text.slice(1));
      if (!Number.isInteger(back) || back < 1) return undefined;
      return turns[turns.length - back];
    }
    const byNumber = Number(text);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= turns.length) {
      return turns[byNumber - 1];
    }
    // A model id is never a number, so a raw id is matched on the rest.
    return turns.find((turn) => turn.id === text);
  }

  /** Which turn a session's transcript would call turn n, and what it holds. */
  async describe(): Promise<Array<{ turn: CheckpointTurn; paths: string[] }>> {
    const turns = await this.list();
    return turns.map((turn, index) => ({
      turn: { ...turn, id: String(index + 1) },
      paths: turn.entries.map((entry) => entry.path),
    }));
  }

  private async putBlob(bytes: Buffer): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = this.blobFile(hash);
    try {
      await stat(file);
      // Re-referenced, so it is live: prune decides by mtime.
      await utimes(file, new Date(), new Date());
      return hash;
    } catch {
      await mkdir(this.blobsDir, { recursive: true });
    }
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, bytes);
    // Two turns capturing identical bytes race to the same content, so the
    // rename that loses is harmless and the blob is never read half-written.
    await rename(tmp, file);
    return hash;
  }

  /** Called by TurnCheckpoint, which owns the turn's entries. */
  async captureInto(turn: TurnCheckpoint, target: string): Promise<void> {
    const rel = checkpointable(this.cwd, target);
    if (rel === undefined) return;
    if (turn.has(rel)) return;
    turn.add(await this.readBefore(rel));
  }

  /**
   * Copy what is at the path now, and say honestly when that was not possible.
   * Reading and storing are tried separately on purpose: a store we cannot
   * write to must not be mistaken for a file that did not exist, or rewind
   * would delete a file the turn had only edited.
   */
  private async readBefore(rel: string): Promise<CheckpointEntry> {
    const abs = path.resolve(this.cwd, rel);
    let bytes: Buffer;
    try {
      const info = await stat(abs);
      if (!info.isFile()) return { path: rel, before: null, skipped: 'unreadable' };
      if (info.size > MAX_FILE_BYTES) return { path: rel, before: null, skipped: 'too large' };
      bytes = await readFile(abs);
    } catch (err) {
      // Absent is the ordinary case: the turn is creating the file.
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? { path: rel, before: null }
        : { path: rel, before: null, skipped: 'unreadable' };
    }
    try {
      return { path: rel, before: await this.putBlob(bytes) };
    } catch {
      return { path: rel, before: null, skipped: 'unreadable' };
    }
  }

  /** Called by TurnCheckpoint; a manifest is written once, when the turn ends. */
  async writeManifest(turn: CheckpointTurn): Promise<void> {
    await mkdir(this.turnsDir, { recursive: true });
    const file = this.manifestFile(turn.id);
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(turn, null, 2), 'utf8');
    await rename(tmp, file);
  }

  /** What rewind would change, without changing it. */
  async plan(id: string): Promise<RewindReport | undefined> {
    const turns = await this.list();
    const turn = turns.find((other) => other.id === id);
    if (!turn) return undefined;
    // Anything starting at or after this turn is a problem: two turns in the
    // same millisecond are concurrent, and which one's bytes end up on disk is
    // decided by the clock's precision rather than by what actually happened.
    const mine = new Set(turn.entries.map((entry) => entry.path));
    const overwrittenBy = turns
      .filter(
        (other) =>
          other.id !== turn.id &&
          other.startedAt >= turn.startedAt &&
          other.entries.some((entry) => mine.has(entry.path)),
      )
      .map((other) => other.id);
    return {
      turn,
      changes: turn.entries.map((entry) => previewChange(entry)),
      overwrittenBy,
      applied: false,
    };
  }

  /**
   * Put every path this turn touched back the way it was. Refuses without a
   * `force` when a later turn changed one of them too, because those changes
   * would be lost along with the ones being undone.
   */
  async rewind(id: string, options: { force?: boolean } = {}): Promise<RewindReport | undefined> {
    const plan = await this.plan(id);
    if (!plan) return undefined;
    if (plan.overwrittenBy.length > 0 && !options.force) return plan;

    const changes: RewindChange[] = [];
    for (const entry of plan.turn.entries) {
      changes.push(await this.applyEntry(entry));
    }
    return { ...plan, changes, applied: true };
  }

  private async applyEntry(entry: CheckpointEntry): Promise<RewindChange> {
    if (entry.skipped) return { path: entry.path, action: 'left', note: notKeptNote(entry) };
    const abs = path.resolve(this.cwd, entry.path);
    try {
      if (entry.before === null) {
        await rm(abs, { force: true });
        return { path: entry.path, action: 'deleted' };
      }
      const bytes = await readFile(this.blobFile(entry.before));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
      return { path: entry.path, action: 'restored' };
    } catch (err) {
      return { path: entry.path, action: 'failed', note: (err as Error).message };
    }
  }

  /** Drop the oldest turns past the cap, then every blob nothing references. */
  async prune(): Promise<void> {
    const turns = await this.list();
    const kept = turns.slice(Math.max(0, turns.length - this.keepTurns));
    for (const turn of turns.slice(0, turns.length - kept.length)) {
      await rm(this.manifestFile(turn.id), { force: true });
    }

    const live = new Set<string>();
    for (const turn of kept) {
      for (const entry of turn.entries) {
        if (entry.before) live.add(entry.before);
      }
    }
    let names: string[];
    try {
      names = await readdir(this.blobsDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - PRUNE_GRACE_MS;
    for (const name of names) {
      if (live.has(name)) continue;
      const file = this.blobFile(name);
      try {
        if ((await stat(file)).mtimeMs > cutoff) continue;
      } catch {
        continue;
      }
      // A stale manifest is what referenced this blob, so losing it only costs
      // undo for a turn nobody can list any more.
      await rm(file, { force: true });
    }
  }
}

/** A turn in progress: one capture per path, whatever the tools do afterwards. */
class TurnCheckpoint implements TurnRecorder {
  readonly id: string;
  readonly startedAt: number;
  private readonly entries = new Map<string, CheckpointEntry>();

  constructor(private readonly store: CheckpointStore) {
    this.startedAt = Date.now();
    this.id = turnId(this.startedAt);
  }

  has(rel: string): boolean {
    return this.entries.has(rel);
  }

  add(entry: CheckpointEntry): void {
    this.entries.set(entry.path, entry);
  }

  async capture(target: string): Promise<void> {
    try {
      await this.store.captureInto(this, target);
    } catch {
      // Checkpointing is never the reason a write fails.
    }
  }

  async finish(): Promise<CheckpointTurn | undefined> {
    if (this.entries.size === 0) return undefined;
    const manifest: CheckpointTurn = {
      id: this.id,
      startedAt: this.startedAt,
      entries: [...this.entries.values()],
    };
    try {
      await this.store.writeManifest(manifest);
      await this.store.prune();
    } catch {
      // A store that will not take the manifest costs the undo for this turn,
      // not the turn: the work is already on disk and failing it now would
      // hide what happened behind an error nobody asked for.
      return undefined;
    }
    return manifest;
  }
}

function notKeptNote(entry: CheckpointEntry): string {
  return `no copy was kept: ${entry.skipped}`;
}

/** What one entry would do, decided without doing it. */
function previewChange(entry: CheckpointEntry): RewindChange {
  if (entry.skipped) return { path: entry.path, action: 'left', note: notKeptNote(entry) };
  return { path: entry.path, action: entry.before === null ? 'deleted' : 'restored' };
}
