import type { ModelHandle, PermissionRequestPayload, TokenTotals } from '../../src/desktop/api.js';
import type { TaskItem } from '../../src/tools/types.js';
import type { Entry } from './transcript';

/**
 * Everything the renderer learns from one session's turn. Each field is owned by
 * a session, so a turn running in the background cannot paint over the
 * conversation that happens to be on screen.
 */
export interface RunBuffer {
  entries: Entry[];
  streaming: string;
  approvals: PermissionRequestPayload[];
  running: boolean;
  startedAt: number | null;
  /** The model the kernel actually started this turn on, which may differ from init. */
  runModel: ModelHandle | null;
  plan: TaskItem[];
  usage: TokenTotals | null;
}

export const emptyBuffer: RunBuffer = {
  entries: [],
  streaming: '',
  approvals: [],
  running: false,
  startedAt: null,
  runModel: null,
  plan: [],
  usage: null,
};

/** Buffers keyed by session id; the empty id holds whatever has no session yet. */
export type Buffers = Record<string, RunBuffer>;

/** Change one session's buffer and leave every other session's alone. */
export function withBuffer(
  all: Buffers,
  sessionId: string,
  change: (buffer: RunBuffer) => RunBuffer,
): Buffers {
  return { ...all, [sessionId]: change(all[sessionId] ?? emptyBuffer) };
}

/** Forget a session's buffer when the session itself is gone. */
export function dropBuffer(all: Buffers, sessionId: string): Buffers {
  if (all[sessionId] === undefined) return all;
  const next = { ...all };
  delete next[sessionId];
  return next;
}

/** The sessions with a turn in flight, in rail order-independent form. */
export function runningIds(all: Buffers): string[] {
  return Object.keys(all).filter((id) => all[id]?.running);
}
