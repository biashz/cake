import type { ModelMessage } from 'ai';
import { runAgent } from '../core/agent.js';
import type { CheckpointStore, CheckpointTurn } from '../core/checkpoints.js';
import { createHistorySummarizer, maybeCompress } from '../core/context.js';
import { addUsage, type CostLine, costLine } from '../core/cost.js';
import type { AgentEvent, TokenUsage } from '../core/events.js';
import { assertImageBudget, imageFilePart } from '../core/images.js';
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
  /** Data URLs attached to this prompt, ahead of any `@file` images. */
  images?: string[];
  maxContext: number;
  /**
   * Where the turn's file changes are archived before they happen, so the turn
   * can be undone. Absent means no undo for this turn; nothing else changes.
   */
  checkpoints?: CheckpointStore;
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
  /**
   * The checkpoint this turn closed, so the turn can be pointed at later by
   * name instead of by position. Absent when nothing was archived or when the
   * run had no store to archive into.
   */
  checkpointId?: string;
}

/** Text alone stays a plain string; one image turns the prompt into content parts. */
function userMessage(text: string, images: readonly string[]): ModelMessage {
  if (images.length === 0) return { role: 'user', content: text };
  return {
    role: 'user',
    content: [{ type: 'text', text }, ...images.map(imageFilePart)],
  };
}

/**
 * Refuse before anything is spent: a model that cannot read images must not be
 * sent one, and a turn cannot carry more than the vendor caps.
 */
function assertImagesUsable(
  registry: ProviderRegistry,
  model: ModelSpec,
  images: readonly string[],
): void {
  if (images.length === 0) return;
  assertImageBudget(images);
  if (!registry.get(model.provider).capabilities(model.modelId).vision) {
    throw new Error(
      `${model.modelId} cannot read images — pick a vision model, or send the turn without attachments`,
    );
  }
}

/**
 * One user turn: expand @codebase/@file references, compress history when needed,
 * then run the agent loop. Shared by the CLI and the desktop client so both paths
 * prepare context and bill nested work identically.
 */
export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const note = options.onNote ?? (() => {});
  const { cwd, registry, model, abortSignal } = options;
  const attached = options.images ?? [];
  assertImagesUsable(registry, model, attached);

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
      text: `not attached (missing, outside the workspace, unreadable or too large): ${expanded.missing.join(', ')}`,
    });
  }

  // One picture, one slot: `@diagram.png` beside an attached copy is still one picture.
  const images = [...new Set([...attached, ...expanded.images])];
  assertImagesUsable(registry, model, images);

  let messages: ModelMessage[] = [...options.history, userMessage(expanded.text, images)];
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
  // One undo archive per turn: what a tool changes is copied before it changes
  // it, and the manifest closes when the turn does, however it ends.
  const undo = options.checkpoints?.beginTurn();
  const ctx: ToolContext = {
    ...options.ctx,
    ...(undo ? { checkpoints: undo } : {}),
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

  let result: Awaited<ReturnType<typeof runAgent>>;
  let closed: CheckpointTurn | undefined;
  try {
    result = await runAgent(
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
  } finally {
    // Cancelled or failed is exactly when an undo is wanted, so the manifest
    // closes on every path out of the turn.
    closed = await undo?.finish();
  }

  lines.unshift(
    costLine(model, result.usage, result.costUsd, { scope: 'main', pricing: options.pricing }),
  );

  return {
    text: result.text,
    messages: result.messages,
    usage: addUsage(result.usage, nestedUsage),
    costUsd: result.costUsd + nestedCostUsd,
    lines,
    ...(closed ? { checkpointId: closed.id } : {}),
  };
}
