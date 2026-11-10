import type { TaskItem, TaskStatus } from '../tools/types.js';

/**
 * The one mark table. The box on the terminal, the `task` tool's own report and
 * the exported transcript all quote the same list, so they cannot quietly start
 * saying different things about the same step.
 */
export const TASK_MARKS: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
};

export interface PlanProgress {
  done: number;
  active: number;
  total: number;
}

/**
 * The plan readout, derived rather than stored: a summary kept beside the list
 * cannot disagree with it.
 */
export function planProgress(tasks: readonly TaskItem[]): PlanProgress {
  let done = 0;
  let active = 0;
  for (const task of tasks) {
    if (task.status === 'completed') done++;
    if (task.status === 'in_progress') active++;
  }
  return { done, active, total: tasks.length };
}
