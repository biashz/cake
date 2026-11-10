import { z } from 'zod';
import { TASK_MARKS } from '../core/plan.js';
import type { CakeTool, TaskItem } from './types.js';

const schema = z.object({
  action: z.enum(['add', 'update', 'list', 'clear']).describe('Operation to perform'),
  subject: z.string().optional().describe('Task description (required for add)'),
  id: z.number().int().positive().optional().describe('Task id (required for update)'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .optional()
    .describe('New status (required for update)'),
});

type Args = z.infer<typeof schema>;

function render(tasks: TaskItem[]): string {
  if (tasks.length === 0) return 'Task list is empty';
  return tasks.map((task) => `${TASK_MARKS[task.status]} ${task.id}. ${task.subject}`).join('\n');
}

/** In-memory checklist so the model can plan and track multi-step work. */
export const taskTool: CakeTool<Args, string> = {
  name: 'task',
  description:
    'Maintain a task list for multi-step work: add, update status, list, or clear. Use it to plan before editing and to mark progress.',
  permission: 'read',
  inputSchema: schema,
  summarize: (args) => {
    if (args.action === 'add') return `add "${args.subject ?? ''}"`;
    if (args.action === 'update') return `#${args.id ?? '?'} → ${args.status ?? '?'}`;
    return args.action;
  },
  matchTarget: () => 'task',
  async execute(args, ctx) {
    const tasks = ctx.tasks;
    const report = () => {
      // A snapshot, not a live list: an event is a point in time.
      ctx.onPlan?.(tasks.map((task) => ({ ...task })));
      return render(tasks);
    };

    switch (args.action) {
      case 'add': {
        if (!args.subject?.trim()) throw new Error('task add requires a subject');
        const id = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
        tasks.push({ id, subject: args.subject.trim(), status: 'pending' });
        return report();
      }
      case 'update': {
        if (args.id === undefined) throw new Error('task update requires an id');
        const task = tasks.find((item) => item.id === args.id);
        if (!task) throw new Error(`No task with id ${args.id}`);
        if (args.status) task.status = args.status;
        if (args.subject?.trim()) task.subject = args.subject.trim();
        return report();
      }
      case 'clear': {
        tasks.length = 0;
        ctx.onPlan?.([]);
        return 'Task list cleared';
      }
      default:
        return render(tasks);
    }
  },
};
