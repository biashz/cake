import { describe, expect, it } from 'vitest';
import {
  costLine,
  estimateCost,
  formatCost,
  normalizeUsage,
  spendLabel,
  unpricedTokens,
} from '../src/core/cost.js';

describe('normalizeUsage', () => {
  it('coerces undefined to zero', () => {
    expect(normalizeUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('sums input and output into total', () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('treats undefined fields as zero', () => {
    expect(normalizeUsage({ inputTokens: undefined, outputTokens: undefined })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });
});

describe('estimateCost', () => {
  it('prices anthropic sonnet input at $3 / 1M tokens', () => {
    const cost = estimateCost(
      { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(3, 6);
  });

  it('prices anthropic sonnet output at $15 / 1M tokens', () => {
    const cost = estimateCost(
      { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      { inputTokens: 0, outputTokens: 1_000_000, totalTokens: 1_000_000 },
    );
    expect(cost).toBeCloseTo(15, 6);
  });

  it('prices deepseek at $0.28 in / $0.42 out per 1M tokens', () => {
    const cost = estimateCost(
      { provider: 'deepseek', modelId: 'deepseek-chat' },
      { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 },
    );
    expect(cost).toBeCloseTo(0.7, 6);
  });

  it('returns 0 for unknown models', () => {
    const cost = estimateCost(
      { provider: 'mystery', modelId: 'unknown' },
      { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
    );
    expect(cost).toBe(0);
  });

  it('uses a workspace rate over the built-in card', () => {
    const cost = estimateCost(
      { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
      { 'anthropic/sonnet': { inputPer1M: 1, outputPer1M: 4 } },
    );
    expect(cost).toBeCloseTo(1, 6);
  });

  it('estimates a model the card does not know once a rate is set', () => {
    const spec = { provider: 'ollama', modelId: 'llama3' };
    const usage = { inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 };
    expect(estimateCost(spec, usage)).toBe(0);
    expect(
      estimateCost(spec, usage, { 'ollama/llama3': { inputPer1M: 2, outputPer1M: 2 } }),
    ).toBeCloseTo(1, 6);
  });
});

describe('formatCost', () => {
  it('formats zero', () => {
    expect(formatCost(0)).toBe('$0.0000');
  });

  it('uses 4 decimals for sub-cent costs', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
  });

  it('uses 3 decimals for larger costs', () => {
    expect(formatCost(1.2)).toBe('$1.200');
  });
});

describe('spendLabel', () => {
  it('says no price set rather than $0.0000 when nothing had a rate', () => {
    expect(spendLabel(0, 2000)).toBe('no price set');
  });

  it('keeps the known part and marks the rest when only some tokens had a rate', () => {
    expect(spendLabel(0.02, 2000)).toBe('$0.020 + unpriced');
  });

  it('falls back to the plain cost when every token was priced', () => {
    expect(spendLabel(0)).toBe('$0.0000');
    expect(spendLabel(0.0012, 0)).toBe('$0.0012');
  });
});

describe('costLine', () => {
  const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

  it('marks a model the card knows as priced', () => {
    const line = costLine({ provider: 'anthropic', modelId: 'claude-sonnet-4-5' }, usage, 0.001, {
      scope: 'main',
    });
    expect(line).toMatchObject({ scope: 'main', priced: true, costUsd: 0.001 });
    expect(line.agentType).toBeUndefined();
  });

  it('marks an unknown model as unpriced even though its cost is 0', () => {
    const line = costLine({ provider: 'ollama', modelId: 'llama3' }, usage, 0, {
      scope: 'subagent',
      agentType: 'explore',
    });
    expect(line).toMatchObject({ scope: 'subagent', agentType: 'explore', priced: false });
  });

  it('follows a workspace rate for a model the card does not know', () => {
    const priced = costLine({ provider: 'ollama', modelId: 'llama3' }, usage, 1, {
      scope: 'main',
      pricing: { 'ollama/llama3': { inputPer1M: 2, outputPer1M: 2 } },
    });
    expect(priced.priced).toBe(true);
  });
});

describe('unpricedTokens', () => {
  it('counts only the tokens of lines without a rate', () => {
    const priced = costLine(
      { provider: 'anthropic', modelId: 'opus-4-5' },
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      0.1,
      { scope: 'main' },
    );
    const free = costLine(
      { provider: 'ollama', modelId: 'llama3' },
      { inputTokens: 40, outputTokens: 60, totalTokens: 100 },
      0,
      { scope: 'subagent', agentType: 'plan' },
    );
    expect(unpricedTokens([priced, free])).toBe(100);
    expect(unpricedTokens([priced])).toBe(0);
  });
});
