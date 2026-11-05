import type { ModelSpec } from '../providers/types.js';
import type { TokenUsage } from './events.js';

interface Pricing {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
}

/**
 * Approximate list pricing (USD per 1M tokens). This is a M0 skeleton: values are
 * indicative and matched by model-id substring. Externalizing/validating pricing is
 * deferred — see plan decision register.
 */
const PRICING_RULES: ReadonlyArray<{ match: (spec: ModelSpec) => boolean; pricing: Pricing }> = [
  {
    match: (s) => s.provider === 'anthropic' && s.modelId.includes('opus'),
    pricing: { inputPer1M: 15, outputPer1M: 75 },
  },
  {
    match: (s) => s.provider === 'anthropic' && s.modelId.includes('haiku'),
    pricing: { inputPer1M: 1, outputPer1M: 5 },
  },
  {
    match: (s) => s.provider === 'anthropic' && s.modelId.includes('sonnet'),
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },
  {
    match: (s) => s.provider === 'openai' && s.modelId.includes('mini'),
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
  {
    match: (s) => s.provider === 'openai' && s.modelId.startsWith('gpt-4o'),
    pricing: { inputPer1M: 2.5, outputPer1M: 10 },
  },
];

/** Convert the SDK's usage object (fields may be undefined) into normalized counts. */
export function normalizeUsage(
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): TokenUsage {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** Sum usage from the parent model call and any nested subagent runs. */
export function addUsage(base: TokenUsage, extra: TokenUsage): TokenUsage {
  return {
    inputTokens: base.inputTokens + extra.inputTokens,
    outputTokens: base.outputTokens + extra.outputTokens,
    totalTokens: base.totalTokens + extra.totalTokens,
  };
}

/** Estimated USD cost for a run. Returns 0 when the model has no known pricing. */ export function estimateCost(
  spec: ModelSpec,
  usage: TokenUsage,
): number {
  const rule = PRICING_RULES.find((r) => r.match(spec));
  if (!rule) return 0;
  const input = (usage.inputTokens / 1_000_000) * rule.pricing.inputPer1M;
  const output = (usage.outputTokens / 1_000_000) * rule.pricing.outputPer1M;
  return round(input + output, 6);
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.0000';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
