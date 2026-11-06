import type { ModelMessage } from 'ai';
import { runAgent } from '../core/agent.js';
import { createHistorySummarizer, maybeCompress } from '../core/context.js';
import { addUsage, type CostLine, costLine } from '../core/cost.js';
import type { AgentEvent, TokenUsage } from '../core/events.js';
import { expandFileReferences } from '../core/mentions.js';
import type { PricingOverrides } from '../core/pricing.js';
import type { PermissionRules } from '../permissions/rules.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { expandCodebaseMention } from '../rag/codebase-mention.js';
import type { Embedder } from '../rag/embedder.js';
import type { CodebaseHit } from '../rag/retrieval.js';
import { buildToolSet } from '../tools/registry.js';
import type { CakeTool, PermissionMode, ToolContext } from '../tools/types.js';

export interface TurnNote {
  kind: 'index' | 'codebase' | 'files' | 'context';
  text: string;
  /** On a codebase note: the chunks actually put in front of the model, best first. */
  hits?: CodebaseHit[];
}

export interface TurnOptions {
  cwd: string;
  registry: ProviderRegistry;
  model: ModelSpec;
  system: string;
  mode: PermissionMode;
  rules: PermissionRules;
  /** Full catalog; permission pruning happens inside the turn. */
  tools: CakeTool[];
  history: ModelMessage[];
  prompt: string;
  maxContext: number;
  /** Rate-card additions from config, used when costing this turn. */
  pricing?: PricingOverrides;
  embedder?: Embedder;
  ctx: ToolContext;
  abortSignal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onNote?: (note: TurnNote) => void;
}

export interface TurnResult {
  text: string;
  messages: ModelMessage[];
  /** Includes usage reported by nested work (subagents). */
  usage: TokenUsage;
  costUsd: number;
  /** The same spend, split by model and by the child agent that caused it. */
  lines: CostLine[];
}

/**
 * One user turn: expand @codebase/@file references, compress history when needed,
 * then run the agent loop. Shared by the CLI and the desktop client so both paths
 * prepare context and bill nested work identically.
 */
export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const note = options.onNote ?? (() => {});
  const { cwd, registry, model, abortSignal } = options;

  const codebase = await expandCodebaseMention(options.prompt, {
    cwd,
    embedder: options.embedder,
    abortSignal,
    onProgress: (text) => note({ kind: 'index', text }),
  });
  if (codebase.hits.length > 0) {
    note({
      kind: 'codebase',
      text: `attached ${codebase.hits.length} ${codebase.hits.length === 1 ? 'chunk' : 'chunks'}`,
      hits: codebase.hits,
    });
  }
  if (codebase.note) note({ kind: 'codebase', text: codebase.note });

  const expanded = await expandFileReferences(codebase.text, cwd);
  if (expanded.files.length > 0) {
    note({ kind: 'files', text: `attached ${expanded.files.join(', ')}` });
  }
  if (expanded.missing.length > 0) {
    note({
      kind: 'files',
      text: `not found or outside workspace: ${expanded.missing.join(', ')}`,
    });
  }

  let messages: ModelMessage[] = [...options.history, { role: 'user', content: expanded.text }];
  try {
    const compressed = await maybeCompress(messages, {
      maxTokens: options.maxContext,
      summarize: createHistorySummarizer(registry, model, abortSignal),
    });
    if (compressed.compressed) note({ kind: 'context', text: 'older history compressed' });
    messages = compressed.messages;
  } catch (err) {
    note({ kind: 'context', text: `compression skipped: ${(err as Error).message}` });
  }

  const nestedUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let nestedCostUsd = 0;
  /**
   * Spend per model, main call first. Folding it into one number loses which
   * model and which child agent a turn paid for, so it is kept per line.
   */
  const lines: CostLine[] = [];
  const ctx: ToolContext = {
    ...options.ctx,
    onPlan: (tasks) => options.onEvent({ type: 'plan', tasks }),
    onUsage: (usage, costUsd, source) => {
      const total = addUsage(nestedUsage, usage);
      nestedUsage.inputTokens = total.inputTokens;
      nestedUsage.outputTokens = total.outputTokens;
      nestedUsage.totalTokens = total.totalTokens;
      nestedCostUsd += costUsd;
      lines.push(
        costLine(source?.model ?? model, usage, costUsd, {
          scope: 'subagent',
          agentType: source?.agentType,
          pricing: options.pricing,
        }),
      );
      options.ctx.onUsage?.(usage, costUsd, source);
    },
  };

  const result = await runAgent(
    {
      model,
      system: options.system,
      tools: buildToolSet(options.tools, ctx, options.mode, options.rules),
      messages,
      abortSignal,
      ...(options.pricing ? { pricing: options.pricing } : {}),
      onEvent: options.onEvent,
    },
    registry,
  );

  lines.unshift(
    costLine(model, result.usage, result.costUsd, { scope: 'main', pricing: options.pricing }),
  );

  return {
    text: result.text,
    messages: result.messages,
    usage: addUsage(result.usage, nestedUsage),
    costUsd: result.costUsd + nestedCostUsd,
    lines,
  };
}
