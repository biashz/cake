import { describe, expect, it } from 'vitest';
import { taskTool } from '../src/tools/task.js';
import type { ToolContext } from '../src/tools/types.js';

function freshCtx(): ToolContext {
  return { cwd: process.cwd(), askPermission: async () => 'allow', log: () => {} };
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
