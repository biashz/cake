import { type ModelMessage, streamText } from 'ai';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { estimateCost, normalizeUsage } from './cost.js';
import type { AgentEvent, TokenUsage } from './events.js';

export interface AgentRun {
  model: ModelSpec;
  messages: ModelMessage[];
  /** Optional system prompt, prepended as a system message. */
  system?: string;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  text: string;
  usage: TokenUsage;
  costUsd: number;
}

/**
 * M0 agent kernel: a single-turn streaming run with no tools. The event-driven
 * shape and the `registry.resolveModel` indirection are the seams that M1 extends
 * into a multi-step tool loop.
 */
export async function runAgent(run: AgentRun, registry: ProviderRegistry): Promise<AgentResult> {
  const emit = run.onEvent ?? (() => {});
  const model = registry.resolveModel(run.model);

  const messages: ModelMessage[] = run.system
    ? [{ role: 'system', content: run.system }, ...run.messages]
    : run.messages;

  emit({ type: 'start', model: run.model });

  const result = streamText({ model, messages, abortSignal: run.abortSignal });

  let text = '';
  try {
    for await (const delta of result.textStream) {
      text += delta;
      emit({ type: 'text-delta', delta });
    }
  } catch (err) {
    if (run.abortSignal?.aborted) {
      const usage = normalizeUsage(undefined);
      emit({ type: 'finish', text, usage, costUsd: 0 });
      return { text, usage, costUsd: 0 };
    }
    const error = err instanceof Error ? err : new Error(String(err));
    emit({ type: 'error', error });
    throw error;
  }

  const usage = normalizeUsage(await result.usage);
  const costUsd = estimateCost(run.model, usage);
  emit({ type: 'finish', text, usage, costUsd });
  return { text, usage, costUsd };
}
