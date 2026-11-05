import type { ModelSpec } from '../providers/types.js';
import type { TokenUsage } from './events.js';
import { type PricingOverrides, resolvePricing } from './pricing.js';

export type { Pricing, PricingOverrides } from './pricing.js';

/**
 * Approximate list pricing lives in `pricing.js` and can be overridden per
 * workspace in `.cake/config.json`. See that file for the matching rules.
 */

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

/**
 * Estimated USD cost for a run. Returns 0 when the model has no known pricing —
 * callers that show a cost should say "no price set" rather than implying free.
 */
export function estimateCost(
  spec: ModelSpec,
  usage: TokenUsage,
  overrides?: PricingOverrides,
): number {
  const match = resolvePricing(spec, overrides);
  if (!match) return 0;
  const input = (usage.inputTokens / 1_000_000) * match.pricing.inputPer1M;
  const output = (usage.outputTokens / 1_000_000) * match.pricing.outputPer1M;
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
