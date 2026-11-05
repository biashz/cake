import { z } from 'zod';
import { formatCost } from '../core/cost.js';
import type { CakeTool } from '../tools/types.js';
import { runSubAgent, type SubAgentRunnerOptions } from './runner.js';

const schema = z.object({
  type: z
    .enum(['explore', 'plan', 'general'])
    .describe(
      'explore: read-only code search and explanation; plan: read-only implementation plan; general: full task execution',
    ),
  prompt: z
    .string()
    .min(1)
    .describe('Self-contained task for the subagent; it cannot see this chat'),
  model: z
    .object({ provider: z.string().min(1), modelId: z.string().min(1) })
    .optional()
    .describe('Override the model for this subagent (defaults to the parent model)'),
  maxSteps: z.number().int().min(1).max(40).optional().describe('Maximum model↔tool steps'),
});

type Args = z.infer<typeof schema>;

function preview(prompt: string): string {
  const line = prompt.split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * Spawn a child agent. Several `agent` calls in one assistant turn run in
 * parallel; each child has its own context window and only returns a summary,
 * which keeps bulk search results out of the parent conversation.
 */
export function createAgentTool(options: SubAgentRunnerOptions): CakeTool<Args, string> {
  return {
    name: 'agent',
    description:
      'Spawn a subagent with an isolated context window and return its summary. Use explore to search the codebase, plan to produce an implementation plan, or general to execute a task. Issue multiple agent calls in one turn to run independent work in parallel. Subagents cannot spawn further subagents.',
    permission: 'read',
    inputSchema: schema,
    summarize: (args) => `${args.type}: ${preview(args.prompt)}`,
    matchTarget: (args) => args.type,
    async execute(args, ctx) {
      const outcome = await runSubAgent(args, ctx, options);
      const tokens = outcome.usage.totalTokens;
      return `[${args.type} agent]\n${outcome.text}\n\n(${tokens} tokens, ${formatCost(outcome.costUsd)})`;
    },
  };
}
