import { describe, expect, it } from 'vitest';
import { taskTool } from '../src/tools/task.js';
import type { TaskItem, ToolContext } from '../src/tools/types.js';

function freshCtx(): ToolContext {
  return { cwd: process.cwd(), tasks: [], askPermission: async () => 'allow', log: () => {} };
}

/** A context that records every plan snapshot the tool pushes out. */
function reportingCtx(): { ctx: ToolContext; snapshots: TaskItem[][] } {
  const snapshots: TaskItem[][] = [];
  const ctx: ToolContext = {
    cwd: process.cwd(),
    tasks: [],
    askPermission: async () => 'allow',
    log: () => {},
    onPlan: (tasks) => snapshots.push(tasks),
  };
  return { ctx, snapshots };
}

describe('task tool', () => {
  it('adds, updates, lists, and clears tasks', async () => {
    const ctx = freshCtx();

    expect(await taskTool.execute({ action: 'add', subject: 'read code' }, ctx)).toBe(
      '[ ] 1. read code',
    );
    expect(await taskTool.execute({ action: 'add', subject: 'edit file' }, ctx)).toBe(
      '[ ] 1. read code\n[ ] 2. edit file',
    );

    expect(
      await taskTool.execute({ action: 'update', id: 1, status: 'in_progress' }, ctx),
    ).toContain('[~] 1. read code');
    expect(await taskTool.execute({ action: 'update', id: 2, status: 'completed' }, ctx)).toContain(
      '[x] 2. edit file',
    );
    expect(await taskTool.execute({ action: 'list' }, ctx)).toBe(
      '[~] 1. read code\n[x] 2. edit file',
    );

    expect(await taskTool.execute({ action: 'clear' }, ctx)).toBe('Task list cleared');
    expect(await taskTool.execute({ action: 'list' }, ctx)).toBe('Task list is empty');
  });

  it('keeps lists isolated per context', async () => {
    const a = freshCtx();
    const b = freshCtx();
    await taskTool.execute({ action: 'add', subject: 'only in a' }, a);
    expect(await taskTool.execute({ action: 'list' }, b)).toBe('Task list is empty');
  });

  it('validates required fields', async () => {
    const ctx = freshCtx();
    await expect(taskTool.execute({ action: 'add' }, ctx)).rejects.toThrow(
      'task add requires a subject',
    );
    await expect(taskTool.execute({ action: 'update', status: 'completed' }, ctx)).rejects.toThrow(
      'task update requires an id',
    );
    await expect(
      taskTool.execute({ action: 'update', id: 9, status: 'completed' }, ctx),
    ).rejects.toThrow('No task with id 9');
  });
});

describe('task plan snapshots', () => {
  it('reports the whole list after every change', async () => {
    const { ctx, snapshots } = reportingCtx();

    await taskTool.execute({ action: 'add', subject: 'read code' }, ctx);
    await taskTool.execute({ action: 'add', subject: 'edit file' }, ctx);
    await taskTool.execute({ action: 'update', id: 1, status: 'in_progress' }, ctx);

    expect(snapshots.map((tasks) => tasks.map((task) => `${task.id}${task.status}`))).toEqual([
      ['1pending'],
      ['1pending', '2pending'],
      ['1in_progress', '2pending'],
    ]);
  });

  it('reports an empty list when cleared', async () => {
    const { ctx, snapshots } = reportingCtx();
    await taskTool.execute({ action: 'add', subject: 'read code' }, ctx);
    await taskTool.execute({ action: 'clear' }, ctx);

    expect(snapshots[snapshots.length - 1]).toEqual([]);
  });

  it('stays silent for a read-only list', async () => {
    const { ctx, snapshots } = reportingCtx();
    await taskTool.execute({ action: 'add', subject: 'read code' }, ctx);
    snapshots.length = 0;

    expect(await taskTool.execute({ action: 'list' }, ctx)).toBe('[ ] 1. read code');
    expect(snapshots).toEqual([]);
  });

  it('reports a snapshot that later edits cannot rewrite', async () => {
    const { ctx, snapshots } = reportingCtx();
    await taskTool.execute({ action: 'add', subject: 'read code' }, ctx);
    await taskTool.execute({ action: 'add', subject: 'edit file' }, ctx);
    await taskTool.execute({ action: 'update', id: 1, status: 'completed' }, ctx);

    // A UI that kept the first snapshot still shows one pending task.
    expect(snapshots[0]).toEqual([{ id: 1, subject: 'read code', status: 'pending' }]);
  });

  it('continues numbering from a restored plan', async () => {
    const ctx = freshCtx();
    ctx.tasks = [{ id: 7, subject: 'from last session', status: 'completed' }];

    expect(await taskTool.execute({ action: 'add', subject: 'next step' }, ctx)).toBe(
      '[x] 7. from last session\n[ ] 8. next step',
    );
  });
});
