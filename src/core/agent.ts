import { type ModelMessage, stepCountIs, streamText, type ToolSet } from 'ai';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ModelSpec } from '../providers/types.js';
import { estimateCost, normalizeUsage } from './cost.js';
import type { AgentEvent, TokenUsage } from './events.js';

export interface AgentRun {
  model: ModelSpec;
  messages: ModelMessage[];
  /** Optional system prompt, passed to the model as instructions. */
  system?: string;
  /** Tools available this run; omitted means a plain chat turn. */
  tools?: ToolSet;
  /** Upper bound on model↔tool steps in one run (default 20). */
  maxSteps?: number;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
  text: string;
  /** Full conversation including tool calls/results, ready for the next turn. */
  messages: ModelMessage[];
  usage: TokenUsage;
  costUsd: number;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Multi-step agent kernel: streams text and executes tool calls until the model
 * stops calling tools or `maxSteps` is reached. Returns the full message history
 * so callers can thread it into the next user turn.
 */
export async function runAgent(run: AgentRun, registry: ProviderRegistry): Promise<AgentResult> {
  const emit = run.onEvent ?? (() => {});
  const model = registry.resolveModel(run.model);

  emit({ type: 'start', model: run.model });

  const hasTools = run.tools !== undefined && Object.keys(run.tools).length > 0;
  const result = streamText({
    model,
    instructions: run.system,
    messages: run.messages,
    ...(hasTools ? { tools: run.tools, stopWhen: stepCountIs(run.maxSteps ?? 20) } : {}),
    abortSignal: run.abortSignal,
  });

  let text = '';
  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          text += part.text;
          emit({ type: 'text-delta', delta: part.text });
          break;
        case 'tool-call':
          emit({ type: 'tool-call', toolName: part.toolName, input: part.input });
          break;
        case 'tool-result':
          emit({
            type: 'tool-result',
            toolName: part.toolName,
            input: part.input,
            output: part.output,
          });
          break;
        case 'tool-error':
          emit({ type: 'tool-error', toolName: part.toolName, error: toError(part.error) });
          break;
        case 'error':
          throw toError(part.error);
      }
    }
  } catch (err) {
    if (run.abortSignal?.aborted) {
      const usage = normalizeUsage(undefined);
      emit({ type: 'finish', text, usage, costUsd: 0 });
      return { text, messages: await collectMessages(run.messages, result), usage, costUsd: 0 };
    }
    const error = toError(err);
    emit({ type: 'error', error });
    throw error;
  }

  const usage = await readUsage(result);
  const costUsd = estimateCost(run.model, usage);
  emit({ type: 'finish', text, usage, costUsd });
  return { text, messages: await collectMessages(run.messages, result), usage, costUsd };
}

type StreamResultTail = {
  totalUsage: PromiseLike<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>;
  responseMessages: PromiseLike<Array<ModelMessage>>;
};

async function readUsage(result: StreamResultTail): Promise<TokenUsage> {
  try {
    return normalizeUsage(await result.totalUsage);
  } catch {
    return normalizeUsage(undefined);
  }
}

async function collectMessages(
  base: ModelMessage[],
  result: StreamResultTail,
): Promise<ModelMessage[]> {
  try {
    const response = await result.responseMessages;
    return [...base, ...response];
  } catch {
    return base;
  }
}
