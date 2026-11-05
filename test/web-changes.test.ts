import { describe, expect, it } from 'vitest';
import { changeStats, collectChanges, diffForTool } from '../web/src/changes';
import type { Entry, ToolInfo } from '../web/src/transcript';

function tool(name: string, input: unknown, status: ToolInfo['status'] = 'done'): ToolInfo {
  return { callId: `${name}-1`, name, input, status };
}

function toolEntry(id: number, info: ToolInfo): Entry {
  return { id, role: 'tool', tool: info };
}

describe('diffForTool', () => {
  const diffLines = (info: ToolInfo) => diffForTool(info).lines;

  it('diffs edit old/new strings', () => {
    expect(diffLines(tool('edit', { path: 'a.ts', old_string: 'one', new_string: 'two' }))).toEqual(
      [
        { type: 'remove', text: 'one' },
        { type: 'add', text: 'two' },
      ],
    );
  });

  it('treats a write as all additions', () => {
    expect(diffLines(tool('write', { path: 'a.ts', content: 'x\ny' }))).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('returns nothing for read-only tools or malformed input', () => {
    for (const info of [
      tool('read', { path: 'a.ts' }),
      tool('edit', { old_string: 'one' }),
      tool('write', null),
    ]) {
      expect(diffForTool(info)).toEqual({ lines: [], adds: 0, removes: 0, hidden: 0 });
    }
  });
});

describe('collectChanges', () => {
  it('ignores non-tool entries and tools without a usable path', () => {
    const entries: Entry[] = [
      { id: 0, role: 'user', text: 'edit something' },
      toolEntry(1, tool('write', { content: 'orphan' })),
      toolEntry(2, tool('bash', { path: 'a.ts', command: 'echo hi' })),
    ];
    expect(collectChanges(entries)).toEqual([]);
  });

  it('aggregates repeated edits to the same file', () => {
    const entries = [
      toolEntry(1, tool('write', { path: 'src/a.ts', content: 'one' })),
      toolEntry(2, tool('edit', { path: 'src/a.ts', old_string: 'one', new_string: 'two' })),
    ];
    const [change] = collectChanges(entries);
    expect(change).toMatchObject({
      path: 'src/a.ts',
      ops: 2,
      adds: 2,
      removes: 1,
      status: 'done',
      tool: 'edit',
    });
    expect(change?.diff.lines).toEqual([
      { type: 'remove', text: 'one' },
      { type: 'add', text: 'two' },
    ]);
  });

  it('keeps the latest status for a file', () => {
    const entries = [
      toolEntry(1, tool('write', { path: 'a.ts', content: 'x' }, 'running')),
      toolEntry(2, tool('write', { path: 'a.ts', content: 'x' }, 'error')),
    ];
    expect(collectChanges(entries)[0]?.status).toBe('error');
  });
});

describe('changeStats', () => {
  it('sums files, additions, and removals', () => {
    const entries = [
      toolEntry(1, tool('write', { path: 'a.ts', content: 'x\ny' })),
      toolEntry(2, tool('edit', { path: 'b.ts', old_string: 'old', new_string: 'new' })),
    ];
    expect(changeStats(collectChanges(entries))).toEqual({ files: 2, adds: 3, removes: 1 });
  });

  it('is zero for no changes', () => {
    expect(changeStats([])).toEqual({ files: 0, adds: 0, removes: 0 });
  });
});
