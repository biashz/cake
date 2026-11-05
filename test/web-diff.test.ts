import { describe, expect, it } from 'vitest';
import { lineDiff } from '../web/src/diff';

describe('lineDiff', () => {
  it('marks identical text as context', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('reports a changed middle line as remove + add', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('renders a new file as additions only', () => {
    expect(lineDiff('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('falls back to all-remove/all-add for very large inputs and caps output', () => {
    const before = Array.from({ length: 1000 }, (_, index) => `a${index}`).join('\n');
    const after = Array.from({ length: 1000 }, (_, index) => `b${index}`).join('\n');
    const lines = lineDiff(before, after);
    expect(lines).toHaveLength(400);
    expect(lines.every((line) => line.type === 'remove')).toBe(true);
  });
});
