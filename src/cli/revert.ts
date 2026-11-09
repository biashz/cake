import type { CheckpointStore, RewindReport } from '../core/checkpoints.js';

/**
 * The one undo surface both `cake --revert` and the interactive `/revert`
 * share, so neither can tell a different story about the same archive.
 */

/** What the archive cannot see, said whenever undo is offered. */
const NOT_COVERED = 'changes made by a shell command or an MCP tool are not in this undo';

function number(turnIds: string[], id: string): string {
  const at = turnIds.indexOf(id);
  return at < 0 ? '?' : String(at + 1);
}

function describeChanges(report: RewindReport): string[] {
  return report.changes.map((change) => {
    const what =
      change.action === 'deleted'
        ? 'deleted (it did not exist then)'
        : change.action === 'failed'
          ? 'could not be undone'
          : change.action;
    return `  ${change.path} ${what}${change.note ? ` (${change.note})` : ''}`;
  });
}

export async function listTurns(store: CheckpointStore): Promise<string> {
  const turns = await store.list();
  if (turns.length === 0) {
    return `no turn has changed a file cake can undo yet; ${NOT_COVERED}`;
  }
  const ids = turns.map((turn) => turn.id);
  const rows = turns.map((turn) => {
    const time = new Date(turn.startedAt).toTimeString().slice(0, 5);
    const paths = turn.entries.map((entry) => entry.path);
    const shown =
      paths.length <= 4
        ? paths.join(', ')
        : `${paths.slice(0, 3).join(', ')} +${paths.length - 3} more`;
    return `  ${number(ids, turn.id).padStart(3)}  ${time}  ${shown}`;
  });
  return [
    `${turns.length} recorded ${turns.length === 1 ? 'turn' : 'turns'}, oldest first:`,
    ...rows,
    '',
    `  /revert <n> undoes one; a bare /revert undoes the newest.`,
    `  ${NOT_COVERED}`,
  ].join('\n');
}

/** Undo one recorded turn and say what moved, or why nothing did. */
export async function revertTurn(store: CheckpointStore, arg: string): Promise<string> {
  const trimmed = arg.trim();
  if (trimmed.toLowerCase() === 'list') return listTurns(store);

  const forced = /(?:^|\s)(?:--?force)(?:\s|$)/i.test(trimmed);
  const asked = trimmed.replace(/(?:^|\s)(?:--?force)(?:\s|$)/i, ' ').trim();
  if (!forced && asked !== '' && !/^-?\d+$/.test(asked)) {
    return `/revert takes a turn number, "list", or --force; got "${asked}"`;
  }

  const turns = await store.list();
  const turn = await store.resolve(asked);
  if (!turn) {
    return asked === ''
      ? `nothing to revert yet; ${NOT_COVERED}`
      : `no recorded turn "${asked}" — 1 to ${Math.max(turns.length, 1)} exist, or use "list"`;
  }

  const ids = turns.map((item) => item.id);
  const askedNumber = number(ids, turn.id);
  const report = await store.rewind(turn.id, { force: forced });
  if (!report) return `turn ${askedNumber} is no longer recorded`;

  if (!report.applied) {
    const later = report.overwrittenBy.map((id) => number(ids, id)).join(', ');
    return [
      `turn ${askedNumber} was not reverted:`,
      `  turn ${later} ${report.overwrittenBy.length === 1 ? 'has' : 'have'} changed the same files since,`,
      '  and undoing this one would lose those changes too.',
      `  revert "${askedNumber} --force" to take them anyway.`,
    ].join('\n');
  }

  return [`turn ${askedNumber} reverted:`, ...describeChanges(report), `  ${NOT_COVERED}`].join(
    '\n',
  );
}
