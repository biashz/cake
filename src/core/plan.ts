import type { TaskItem } from '../tools/types.js';

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
