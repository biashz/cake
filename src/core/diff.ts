export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
}

/**
 * `adds`/`removes` describe the whole change while `lines` is what fits on screen.
 * Keeping them apart stops a 5000-line write from reporting itself as a 400-line one.
 */
export interface DiffResult {
  lines: DiffLine[];
  adds: number;
  removes: number;
  /** Lines the change had that this view dropped. */
  hidden: number;
}

/** A run of changes with a little context around it, the unit a reviewer reads. */
export interface Hunk {
  /** 1-based line of the new file where this hunk starts. */
  start: number;
  adds: number;
  removes: number;
  lines: DiffLine[];
}

/** Long inputs get a cheap all-add/all-remove rendering instead of quadratic DP. */
const MAX_DP_CELLS = 400_000;
const MAX_OUTPUT_LINES = 400;
export const CONTEXT_LINES = 3;

function counted(lines: DiffLine[], type: DiffLine['type']): number {
  let total = 0;
  for (const line of lines) if (line.type === type) total++;
  return total;
}

function toResult(all: DiffLine[]): DiffResult {
  const shown = all.slice(0, MAX_OUTPUT_LINES);
  return {
    lines: shown,
    adds: counted(all, 'add'),
    removes: counted(all, 'remove'),
    hidden: all.length - shown.length,
  };
}

/** Shrink a diff for a smaller surface, keeping the counts describing the whole change. */
export function cap(result: DiffResult, max: number): DiffResult {
  if (result.lines.length <= max) return result;
  return {
    ...result,
    lines: result.lines.slice(0, max),
    hidden: result.hidden + result.lines.length - max,
  };
}

/**
 * Budget a diff across hunks without letting the trim touch the tallies: a hunk
 * header still reports what it changed even when only part of it is displayed.
 */
export interface ShownHunk {
  hunk: Hunk;
  lines: DiffLine[];
}

export function fitHunks(lines: DiffLine[], max: number): { hunks: ShownHunk[]; hidden: number } {
  const all = hunks(lines);
  if (max <= 0) {
    return { hunks: all.map((hunk) => ({ hunk, lines: hunk.lines })), hidden: 0 };
  }

  const shown: ShownHunk[] = [];
  let left = max;
  let hidden = 0;
  for (const hunk of all) {
    const keep = Math.min(left, hunk.lines.length);
    const visible = hunk.lines.slice(0, keep);
    left -= visible.length;
    hidden += hunk.lines.length - visible.length;
    if (visible.length > 0) shown.push({ hunk, lines: visible });
  }
  return { hunks: shown, hidden };
}

export function lineDiff(before: string, after: string): DiffResult {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  const lines: DiffLine[] = [
    ...a.slice(0, prefix).map((text) => ({ type: 'context' as const, text })),
  ];

  if (aMid.length * bMid.length > MAX_DP_CELLS) {
    lines.push(...aMid.map((text) => ({ type: 'remove' as const, text })));
    lines.push(...bMid.map((text) => ({ type: 'add' as const, text })));
  } else {
    lines.push(...lcsDiff(aMid, bMid));
  }

  if (suffix > 0) {
    lines.push(...a.slice(a.length - suffix).map((text) => ({ type: 'context' as const, text })));
  }
  return toResult(lines);
}

/**
 * Group changes into hunks, merging runs that sit within two context widths of
 * each other so a reviewer sees one block per edit rather than one per line.
 */
export function hunks(lines: DiffLine[], context = CONTEXT_LINES): Hunk[] {
  const changed: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.type !== 'context') changed.push(index);
  }
  if (changed.length === 0) return [];

  const groups: Array<[number, number]> = [];
  let from = changed[0] as number;
  let to = changed[0] as number;
  for (const index of changed.slice(1)) {
    if (index - to > context * 2) {
      groups.push([from, to]);
      from = index;
    }
    to = index;
  }
  groups.push([from, to]);

  return groups.map(([groupFrom, groupTo]) => {
    const lo = Math.max(0, groupFrom - context);
    const hi = Math.min(lines.length - 1, groupTo + context);
    let before = 0;
    for (let index = 0; index < lo; index++) {
      if (lines[index]?.type !== 'remove') before++;
    }
    const slice = lines.slice(lo, hi + 1);
    return {
      start: before + 1,
      adds: counted(slice, 'add'),
      removes: counted(slice, 'remove'),
      lines: slice,
    };
  });
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const cell = (row: number, col: number): number => table[row]?.[col] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i];
    if (!row) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: 'context', text: a[i] ?? '' });
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      lines.push({ type: 'remove', text: a[i] ?? '' });
      i++;
    } else {
      lines.push({ type: 'add', text: b[j] ?? '' });
      j++;
    }
  }
  for (; i < a.length; i++) lines.push({ type: 'remove', text: a[i] ?? '' });
  for (; j < b.length; j++) lines.push({ type: 'add', text: b[j] ?? '' });
  return lines;
}
