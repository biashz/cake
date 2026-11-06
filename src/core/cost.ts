import type { ModelSpec } from '../providers/types.js';
import type { TokenUsage } from './events.js';
import { hasPricing, type PricingOverrides, resolvePricing } from './pricing.js';

export type { Pricing, PricingOverrides } from './pricing.js';

/** Where a line of spend came from: the session's own model, or a child agent. */
export type CostScope = 'main' | 'subagent';

/**
 * One model's share of one turn, kept so spend can be attributed instead of only
 * summed. `priced` is false when cake had no rate for that model, which is not the
 * same as the turn being free.
 */
export interface CostLine {
  model: ModelSpec;
  scope: CostScope;
  /** Subagent type for nested work; absent on the main line. */
  agentType?: string;
  usage: TokenUsage;
  costUsd: number;
  priced: boolean;
}

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

/**
 * Spend text that never reads as free. Tokens from a model with no rate are
 * counted separately, because `$0.0000` for an unpriced model is a wrong number.
 */
export function spendLabel(costUsd: number, unpriced = 0): string {
  if (unpriced <= 0) return formatCost(costUsd);
  return costUsd > 0 ? `${formatCost(costUsd)} + unpriced` : 'no price set';
}

/** Tokens spent on models cake has no rate for, so their cost stays unknown. */
export function unpricedTokens(lines: readonly CostLine[]): number {
  return lines.reduce((sum, line) => (line.priced ? sum : sum + line.usage.totalTokens), 0);
}

/** One line of a turn's spend, with whether cake knows a rate for that model. */
export function costLine(
  model: ModelSpec,
  usage: TokenUsage,
  costUsd: number,
  options: { scope: CostScope; agentType?: string; pricing?: PricingOverrides },
): CostLine {
  const priced = hasPricing(model, options.pricing);
  return {
    model,
    scope: options.scope,
    ...(options.agentType === undefined ? {} : { agentType: options.agentType }),
    usage,
    costUsd,
    priced,
  };
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
