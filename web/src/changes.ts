import { type DiffResult, lineDiff } from './diff';
import type { Entry, ToolInfo } from './transcript';

export interface FileChange {
  path: string;
  ops: number;
  adds: number;
  removes: number;
  diff: DiffResult;
  status: 'running' | 'done' | 'error';
  tool: string;
}

const NO_DIFF: DiffResult = { lines: [], adds: 0, removes: 0, hidden: 0 };

/** Diff implied by a write/edit tool call, or empty for other tools. */
export function diffForTool(tool: ToolInfo): DiffResult {
  if (typeof tool.input !== 'object' || tool.input === null) return NO_DIFF;
  const input = tool.input as Record<string, unknown>;
  if (
    tool.name === 'edit' &&
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'
  ) {
    return lineDiff(input.old_string, input.new_string);
  }
  if (tool.name === 'write' && typeof input.content === 'string') {
    return lineDiff('', input.content);
  }
  return NO_DIFF;
}

function pathFor(tool: ToolInfo): string | undefined {
  if (typeof tool.input !== 'object' || tool.input === null) return undefined;
  const path = (tool.input as Record<string, unknown>).path;
  return typeof path === 'string' && path.trim() !== '' ? path : undefined;
}

/** Aggregate every write/edit in the transcript into one entry per file. */
export function collectChanges(entries: Entry[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const entry of entries) {
    if (entry.role !== 'tool' || !entry.tool || entry.tool.status !== 'done') continue;
    const path = pathFor(entry.tool);
    const diff = diffForTool(entry.tool);
    if (!path || diff.lines.length === 0) continue;

    const previous = byPath.get(path);
    byPath.set(path, {
      path,
      ops: (previous?.ops ?? 0) + 1,
      adds: (previous?.adds ?? 0) + diff.adds,
      removes: (previous?.removes ?? 0) + diff.removes,
      diff,
      status: entry.tool.status,
      tool: entry.tool.name,
    });
  }
  return [...byPath.values()];
}

export function changeStats(changes: FileChange[]): {
  files: number;
  adds: number;
  removes: number;
} {
  return changes.reduce(
    (total, change) => ({
      files: total.files + 1,
      adds: total.adds + change.adds,
      removes: total.removes + change.removes,
    }),
    { files: 0, adds: 0, removes: 0 },
  );
}
