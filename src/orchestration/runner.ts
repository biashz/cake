import { runAgent } from '../core/agent.js';
import type { AgentEvent } from '../core/events.js';
import type { PermissionRules } from '../permissions/rules.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { buildToolSet } from '../tools/registry.js';
import type { CakeTool, PermissionMode, ToolContext } from '../tools/types.js';
import { systemPromptFor } from './prompts.js';
import type { AgentType, SubAgentOutcome, SubAgentSpec } from './types.js';

const READ_ONLY_TYPES = new Set<AgentType>(['explore', 'plan']);
const DEFAULT_MAX_STEPS = 12;

/** Options shared by every child run spawned from one parent turn. */
export interface SubAgentRunnerOptions {
  registry: ProviderRegistry;
  /** Model inherited by child agents unless the spec overrides it. */
  model: ModelSpec;
  /** Parent system prompt (project conventions included). */
  systemBase: string;
  /** Full tool catalog; the runner narrows it per agent type. */
  tools: CakeTool[];
  mode: PermissionMode;
  rules: PermissionRules;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

function toolsFor(type: AgentType, tools: CakeTool[]): CakeTool[] {
  const withoutNesting = tools.filter((tool) => tool.name !== 'agent');
  if (!READ_ONLY_TYPES.has(type)) return withoutNesting;
  return withoutNesting.filter((tool) => tool.permission === 'read');
}

/**
 * Run a child agent with its own context window and a narrowed tool set.
 * Explore/plan children are forced into plan mode (read-only); general children
 * inherit the parent mode and permission rules. Children cannot spawn children.
 */
export async function runSubAgent(
  spec: SubAgentSpec,
  parentCtx: ToolContext,
  options: SubAgentRunnerOptions,
): Promise<SubAgentOutcome> {
  const readOnly = READ_ONLY_TYPES.has(spec.type);
  const mode: PermissionMode = readOnly ? 'plan' : options.mode;
  const model = spec.model ?? options.model;

  if (!parentCtx.tasks) parentCtx.tasks = [];
  const ctx: ToolContext = {
    cwd: parentCtx.cwd,
    askPermission: parentCtx.askPermission,
    log: parentCtx.log,
    tasks: parentCtx.tasks,
    ...(parentCtx.onUsage ? { onUsage: parentCtx.onUsage } : {}),
  };

  options.onEvent?.({ type: 'subagent-start', agentType: spec.type, prompt: spec.prompt });

  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent(
      {
        model,
        system: systemPromptFor(spec.type, options.systemBase),
        tools: buildToolSet(toolsFor(spec.type, options.tools), ctx, mode, options.rules),
        messages: [{ role: 'user', content: spec.prompt }],
        maxSteps: Math.min(spec.maxSteps ?? DEFAULT_MAX_STEPS, 40),
        abortSignal: options.abortSignal,
        onEvent: (event) => {
          if (event.type === 'tool-call' || event.type === 'tool-error') {
            options.onEvent?.({ ...event, toolName: `${spec.type}:${event.toolName}` });
          }
        },
      },
      options.registry,
    );
  } catch (err) {
    options.onEvent?.({
      type: 'subagent-end',
      agentType: spec.type,
      prompt: spec.prompt,
      text: `(failed: ${(err as Error).message})`,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
    });
    throw err;
  }

  parentCtx.onUsage?.(result.usage, result.costUsd);
  const text = result.text.trim() || '(subagent produced no text)';
  options.onEvent?.({
    type: 'subagent-end',
    agentType: spec.type,
    prompt: spec.prompt,
    text,
    usage: result.usage,
    costUsd: result.costUsd,
  });

  return {
    type: spec.type,
    text,
    usage: result.usage,
    costUsd: result.costUsd,
    messages: result.messages,
  };
}
