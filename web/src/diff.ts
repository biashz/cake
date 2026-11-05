export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
}

/** Long inputs get a cheap all-add/all-remove rendering instead of quadratic DP. */
const MAX_DP_CELLS = 400_000;
const MAX_OUTPUT_LINES = 400;

export function lineDiff(before: string, after: string): DiffLine[] {
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
  return lines.slice(0, MAX_OUTPUT_LINES);
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
