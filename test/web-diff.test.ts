import { describe, expect, it } from 'vitest';
import { type DiffLine, fitHunks, hunks, lineDiff } from '../src/core/diff.js';

const lines = (before: string, after: string): DiffLine[] => lineDiff(before, after).lines;

describe('lineDiff', () => {
  it('marks identical text as context', () => {
    expect(lines('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('reports a changed middle line as remove + add', () => {
    expect(lines('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('renders a new file as additions only', () => {
    expect(lines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('falls back to all-remove/all-add for very large inputs and caps output', () => {
    const before = Array.from({ length: 1000 }, (_, index) => `a${index}`).join('\n');
    const after = Array.from({ length: 1000 }, (_, index) => `b${index}`).join('\n');
    const result = lineDiff(before, after);
    expect(result.lines).toHaveLength(400);
    expect(result.lines.every((line) => line.type === 'remove')).toBe(true);
  });

  it('counts the whole change even when the view is capped', () => {
    const before = Array.from({ length: 1000 }, (_, index) => `a${index}`).join('\n');
    const after = Array.from({ length: 1000 }, (_, index) => `b${index}`).join('\n');
    const result = lineDiff(before, after);
    expect(result).toMatchObject({ adds: 1000, removes: 1000, hidden: 1600 });
  });
});

describe('hunks', () => {
  it('returns nothing when no line changed', () => {
    expect(hunks([{ type: 'context', text: 'a' }])).toEqual([]);
  });

  it('keeps three context lines around a change', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const after = ['1', '2', '3', '4', 'x', '6', '7', '8', '9'].join('\n');
    const groups = hunks(lines(before, after));

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ start: 2, adds: 1, removes: 1 });
    expect(groups[0]?.lines.map((line) => line.text)).toEqual([
      '2',
      '3',
      '4',
      '5',
      'x',
      '6',
      '7',
      '8',
    ]);
  });

  it('splits edits that are far apart and merges ones that are close', () => {
    const before = Array.from({ length: 30 }, (_, index) => `l${index}`).join('\n');

    const after = before
      .split('\n')
      .map((line) => (line === 'l2' || line === 'l5' || line === 'l25' ? `${line}!` : line))
      .join('\n');
    const groups = hunks(lineDiff(before, after).lines);

    // l2 and l5 sit within two context widths of each other, so they share a hunk.
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ adds: 2, removes: 2 });
    expect(groups[1]).toMatchObject({ start: 23, adds: 1, removes: 1 });
  });

  it('numbers a hunk from its first displayed line in the new file', () => {
    const added = hunks(lines('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nX\ne\nf\ng\nh'));
    expect(added.map((hunk) => hunk.start)).toEqual([2]);

    const removed = hunks(lines('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\nf\ng\nh'));
    expect(removed.map((hunk) => hunk.start)).toEqual([2]);
  });
});

describe('fitHunks', () => {
  const before = Array.from({ length: 30 }, (_, index) => `l${index}`).join('\n');
  const after = before
    .split('\n')
    .map((line) => (line === 'l2' || line === 'l25' ? `${line}!` : line))
    .join('\n');

  it('shows everything and hides nothing when there is no budget', () => {
    const view = fitHunks(lines(before, after), 0);
    expect(view.hidden).toBe(0);
    expect(view.hunks.map((entry) => entry.lines.length)).toEqual([7, 8]);
  });

  it('trims the display without trimming the tally', () => {
    const view = fitHunks(lines(before, after), 10);

    expect(view.hunks.map((entry) => entry.lines.length)).toEqual([7, 3]);
    expect(view.hidden).toBe(5);
    // The second hunk is only partly on screen but still says what it changed.
    expect(view.hunks[1]?.hunk).toMatchObject({ start: 23, adds: 1, removes: 1 });
  });

  it('drops a hunk the budget never reaches and counts it as hidden', () => {
    const view = fitHunks(lines(before, after), 7);

    expect(view.hunks).toHaveLength(1);
    expect(view.hidden).toBe(8);
  });

  it('keeps a one-hunk diff honest when it is cut in half', () => {
    const added = Array.from({ length: 90 }, (_, index) => ({
      type: 'add' as const,
      text: `line${index}`,
    }));
    const view = fitHunks(added, 60);

    expect(view.hunks[0]?.hunk.adds).toBe(90);
    expect(view.hunks[0]?.lines).toHaveLength(60);
    expect(view.hidden).toBe(30);
  });
});
