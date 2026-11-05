import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICING, hasPricing, parsePattern, resolvePricing } from '../src/core/pricing.js';

const sonnet = { provider: 'anthropic', modelId: 'claude-sonnet-4-5' };

describe('parsePattern', () => {
  it('splits on the first slash only', () => {
    expect(parsePattern('anthropic/claude/3.5')).toEqual({
      provider: 'anthropic',
      model: 'claude/3.5',
    });
  });

  it('reads a bare provider as pricing all of its models', () => {
    expect(parsePattern('deepseek')).toEqual({ provider: 'deepseek', model: '' });
    expect(
      resolvePricing(
        { provider: 'deepseek', modelId: 'anything' },
        { deepseek: { inputPer1M: 1, outputPer1M: 2 } },
      )?.source,
    ).toBe('config');
  });
});

describe('resolvePricing', () => {
  it('takes a config rate over the built-in card', () => {
    const match = resolvePricing(sonnet, { 'anthropic/sonnet': { inputPer1M: 1, outputPer1M: 4 } });
    expect(match).toEqual({
      pricing: { inputPer1M: 1, outputPer1M: 4 },
      pattern: 'anthropic/sonnet',
      source: 'config',
    });
  });

  it('takes the most specific config pattern, not the first key', () => {
    const match = resolvePricing(sonnet, {
      'anthropic/': { inputPer1M: 9, outputPer1M: 9 },
      'anthropic/sonnet-4-5': { inputPer1M: 2, outputPer1M: 10 },
      'anthropic/sonnet': { inputPer1M: 1, outputPer1M: 4 },
    });
    expect(match?.pattern).toBe('anthropic/sonnet-4-5');
  });

  it('ignores a config rate for another provider', () => {
    const match = resolvePricing(sonnet, { 'openai/sonnet': { inputPer1M: 9, outputPer1M: 9 } });
    expect(match?.source).toBe('builtin');
    expect(match?.pricing).toEqual({ inputPer1M: 3, outputPer1M: 15 });
  });

  it('prices the cheaper variant when two built-ins match', () => {
    const mini = resolvePricing({ provider: 'openai', modelId: 'gpt-4o-mini' });
    expect(mini?.pattern).toBe('openai/gpt-4o-mini');
    expect(mini?.pricing).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
    expect(resolvePricing({ provider: 'openai', modelId: 'gpt-4o' })?.pattern).toBe(
      'openai/gpt-4o',
    );
  });

  it('reports no price for a model it does not know', () => {
    const local = { provider: 'ollama', modelId: 'llama3' };
    expect(resolvePricing(local)).toBeUndefined();
    expect(hasPricing(local)).toBe(false);
    expect(hasPricing(local, { 'ollama/llama3': { inputPer1M: 0, outputPer1M: 0 } })).toBe(true);
  });

  it('ships a card of shaped patterns and positive rates', () => {
    for (const entry of BUILTIN_PRICING) {
      expect(entry.pattern).toContain('/');
      expect(entry.pricing.inputPer1M).toBeGreaterThan(0);
      expect(entry.pricing.outputPer1M).toBeGreaterThan(0);
    }
  });

  it('never mutates the built-in card while sorting matches', () => {
    const before = BUILTIN_PRICING.map((entry) => entry.pattern).join(',');
    resolvePricing({ provider: 'openai', modelId: 'gpt-4o-mini' }, {});
    expect(BUILTIN_PRICING.map((entry) => entry.pattern).join(',')).toBe(before);
  });
});
