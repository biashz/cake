import type { ModelSpec } from '../providers/types.js';

/** USD per 1M tokens. */
export interface Pricing {
  inputPer1M: number;
  outputPer1M: number;
}

export type PricingSource = 'config' | 'builtin';

export interface PricingMatch {
  pricing: Pricing;
  /** The `provider/model-part` that answered. */
  pattern: string;
  source: PricingSource;
}

/**
 * `provider/model-substring`, where the longest model part that matches wins.
 * Values are indicative list prices; a config entry with the same shape overrides
 * them, and an empty model part prices every model of that provider.
 */
export const BUILTIN_PRICING: ReadonlyArray<{ pattern: string; pricing: Pricing }> = [
  { pattern: 'anthropic/opus', pricing: { inputPer1M: 15, outputPer1M: 75 } },
  { pattern: 'anthropic/haiku', pricing: { inputPer1M: 1, outputPer1M: 5 } },
  { pattern: 'anthropic/sonnet', pricing: { inputPer1M: 3, outputPer1M: 15 } },
  { pattern: 'deepseek/', pricing: { inputPer1M: 0.28, outputPer1M: 0.42 } },
  { pattern: 'openai/gpt-4o-mini', pricing: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { pattern: 'openai/gpt-4o', pricing: { inputPer1M: 2.5, outputPer1M: 10 } },
];

/** Rates supplied by the user, keyed by the same `provider/model-substring` shape. */
export type PricingOverrides = Readonly<Record<string, Pricing>>;

export function parsePattern(pattern: string): { provider: string; model: string } {
  const index = pattern.indexOf('/');
  return {
    provider: index < 0 ? pattern : pattern.slice(0, index),
    model: index < 0 ? '' : pattern.slice(index + 1),
  };
}

function matches(pattern: string, spec: ModelSpec): boolean {
  const { provider, model } = parsePattern(pattern);
  return spec.provider === provider && spec.modelId.includes(model);
}

/** Longer model parts are more specific, so they answer first within one source. */
function specificity(pattern: string): number {
  return parsePattern(pattern).model.length;
}

/**
 * The rate card for one model: your config first, then the built-in table.
 * `undefined` means cake has no price for it, which is not the same as free.
 */
export function resolvePricing(
  spec: ModelSpec,
  overrides: PricingOverrides = {},
): PricingMatch | undefined {
  const configured = Object.keys(overrides)
    .filter((pattern) => matches(pattern, spec))
    .sort((a, b) => specificity(b) - specificity(a));
  const first = configured[0];
  if (first !== undefined && overrides[first]) {
    return { pricing: overrides[first], pattern: first, source: 'config' };
  }

  const builtins = BUILTIN_PRICING.filter((entry) => matches(entry.pattern, spec)).sort(
    (a, b) => specificity(b.pattern) - specificity(a.pattern),
  );
  const hit = builtins[0];
  return hit ? { pricing: hit.pricing, pattern: hit.pattern, source: 'builtin' } : undefined;
}

export function hasPricing(spec: ModelSpec, overrides?: PricingOverrides): boolean {
  return resolvePricing(spec, overrides) !== undefined;
}
