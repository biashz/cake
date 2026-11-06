import type { CostScope } from './cost.js';

/**
 * One billed line, as it is stored per turn. `priced` is false when cake had no
 * rate for that model at the time, so its tokens are counted but never faked as
 * free spend.
 */
export interface CostRow {
  turn: number;
  /** Order within the turn; two rows can otherwise share every field. */
  seq: number;
  occurredAt: number;
  provider: string;
  model: string;
  scope: CostScope;
  /** Subagent type for nested work; empty for the session's own model. */
  agentType: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  priced: boolean;
}

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Tokens from rows with no rate; spend they caused cannot be known. */
  unpricedTokens: number;
  turns: number;
}

export interface CostTurn {
  turn: number;
  occurredAt: number;
  costUsd: number;
  totalTokens: number;
  unpricedTokens: number;
  rows: CostRow[];
}

/** A group of rows sharing one model (or one kind of work). */
export interface CostGroup extends CostTotals {
  key: string;
  label: string;
}

export interface CostBoard {
  totals: CostTotals;
  /** Newest first, at most `limit` of them. */
  turns: CostTurn[];
  /** False when older turns were left out of `turns`. */
  truncated: boolean;
  /** Spend per model, most expensive first. */
  models: CostGroup[];
  /** The session's own model vs each kind of nested work. */
  work: CostGroup[];
}

/**
 * What one workspace has spent over every session. Each session carries its own
 * roll-up, including the tokens it billed with no rate, so work saved before
 * per-turn detail existed still counts.
 */
export interface WorkspaceSpend {
  sessions: number;
  costUsd: number;
  totalTokens: number;
  unpricedTokens: number;
}

function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function emptyTotals(): CostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
    turns: 0,
  };
}

function addRow(totals: CostTotals, row: CostRow, turns: Set<number>): void {
  totals.inputTokens += row.inputTokens;
  totals.outputTokens += row.outputTokens;
  totals.totalTokens += row.totalTokens;
  totals.costUsd = roundUsd(totals.costUsd + row.costUsd);
  if (!row.priced) totals.unpricedTokens += row.totalTokens;
  turns.add(row.turn);
}

function withTurns(totals: CostTotals, turns: Set<number>): CostTotals {
  return { ...totals, turns: turns.size };
}

/** A group's totals plus how many distinct turns contributed to it. */
function finish(entry: { group: CostGroup; turns: Set<number> }): CostGroup {
  return { ...entry.group, turns: entry.turns.size };
}

/** The session's own model leads; nested work follows by spend. */
function mainFirst(a: CostGroup, b: CostGroup): number {
  if (a.key === 'main') return b.key === 'main' ? 0 : -1;
  if (b.key === 'main') return 1;
  return bySpend(a, b);
}

function bySpend(a: CostGroup, b: CostGroup): number {
  return b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || a.label.localeCompare(b.label);
}

function modelLabel(row: CostRow): string {
  return `${row.provider}/${row.model}`;
}

function workGroup(row: CostRow): { key: string; label: string } {
  if (row.scope === 'main') return { key: 'main', label: `Main model · ${modelLabel(row)}` };
  return {
    key: `subagent:${row.agentType}`,
    label: row.agentType ? `Subagent: ${row.agentType}` : 'Nested work',
  };
}

/**
 * Turn, model and nested-work breakdown of the rows one session billed. Grouping
 * happens here rather than in the view so the same numbers back the header chip,
 * the `/cost` note, and the Inspector board.
 */
export function buildCostBoard(rows: readonly CostRow[], limit = 40): CostBoard {
  // Stable sort: rows of one turn keep the order the store returned them in.
  const ordered = [...rows].sort((a, b) => a.turn - b.turn);

  const totals = emptyTotals();
  const allTurns = new Set<number>();
  const modelGroups = new Map<string, { group: CostGroup; turns: Set<number> }>();
  const workGroups = new Map<string, { group: CostGroup; turns: Set<number> }>();
  const byTurn = new Map<number, CostTurn>();

  for (const row of ordered) {
    addRow(totals, row, allTurns);

    const modelKey = modelLabel(row);
    const modelEntry = modelGroups.get(modelKey) ?? {
      group: { key: modelKey, label: modelKey, ...emptyTotals() },
      turns: new Set<number>(),
    };
    addRow(modelEntry.group, row, modelEntry.turns);
    modelGroups.set(modelKey, modelEntry);

    const work = workGroup(row);
    const workEntry = workGroups.get(work.key) ?? {
      group: { key: work.key, label: work.label, ...emptyTotals() },
      turns: new Set<number>(),
    };
    addRow(workEntry.group, row, workEntry.turns);
    workGroups.set(work.key, workEntry);

    const turn = byTurn.get(row.turn) ?? {
      turn: row.turn,
      occurredAt: row.occurredAt,
      costUsd: 0,
      totalTokens: 0,
      unpricedTokens: 0,
      rows: [],
    };
    turn.occurredAt = Math.max(turn.occurredAt, row.occurredAt);
    turn.costUsd = roundUsd(turn.costUsd + row.costUsd);
    turn.totalTokens += row.totalTokens;
    if (!row.priced) turn.unpricedTokens += row.totalTokens;
    turn.rows.push(row);
    byTurn.set(row.turn, turn);
  }

  const newestFirst = [...byTurn.values()].sort((a, b) => b.turn - a.turn);

  return {
    totals: withTurns(totals, allTurns),
    turns: newestFirst.slice(0, Math.max(0, limit)),
    truncated: newestFirst.length > limit,
    models: [...modelGroups.values()].map(finish).sort(bySpend),
    work: [...workGroups.values()].map(finish).sort(mainFirst),
  };
}

/** An empty board, so a view can render "nothing billed yet" without null checks. */
export function emptyCostBoard(): CostBoard {
  return { totals: emptyTotals(), turns: [], truncated: false, models: [], work: [] };
}
