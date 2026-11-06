import { describe, expect, it } from 'vitest';
import { buildCostBoard, type CostRow } from '../src/core/cost-board.js';

function row(overrides: Partial<CostRow> & Pick<CostRow, 'turn'>): CostRow {
  return {
    occurredAt: 1_700_000_000_000 + overrides.turn,
    seq: 0,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    scope: 'main',
    agentType: '',
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    costUsd: 0.01,
    priced: true,
    ...overrides,
  };
}

describe('buildCostBoard totals', () => {
  it('is empty when nothing was billed', () => {
    const board = buildCostBoard([]);
    expect(board.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedTokens: 0,
      turns: 0,
    });
    expect(board.turns).toEqual([]);
    expect(board.truncated).toBe(false);
  });

  it('sums tokens and cost over every line and counts distinct turns', () => {
    const board = buildCostBoard([
      row({ turn: 1 }),
      row({ turn: 2, costUsd: 0.02, inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 }),
      row({ turn: 2, scope: 'subagent', agentType: 'explore', costUsd: 0.005 }),
    ]);
    expect(board.totals).toMatchObject({ costUsd: 0.035, inputTokens: 4000, turns: 2 });
    expect(board.totals.totalTokens).toBe(6000);
  });

  it('counts tokens without a rate instead of letting them read as free', () => {
    const board = buildCostBoard([
      row({ turn: 1, costUsd: 0.01 }),
      row({ turn: 1, provider: 'ollama', model: 'llama3', costUsd: 0, priced: false }),
    ]);
    expect(board.totals.costUsd).toBe(0.01);
    expect(board.totals.unpricedTokens).toBe(1500);
  });
});

describe('buildCostBoard by turn', () => {
  it('keeps a turn and its nested work together, newest first', () => {
    const board = buildCostBoard([
      row({ turn: 1 }),
      row({ turn: 2 }),
      row({ turn: 2, scope: 'subagent', agentType: 'plan', costUsd: 0.004 }),
    ]);
    expect(board.turns.map((turn) => turn.turn)).toEqual([2, 1]);
    expect(board.turns[0]?.costUsd).toBe(0.014);
    expect(board.turns[0]?.rows.map((line) => line.scope)).toEqual(['main', 'subagent']);
  });

  it('lists only the latest turns and says so', () => {
    const rows = Array.from({ length: 5 }, (_, index) => row({ turn: index + 1 }));
    const board = buildCostBoard(rows, 2);
    expect(board.turns.map((turn) => turn.turn)).toEqual([5, 4]);
    expect(board.truncated).toBe(true);
    // The totals still cover every turn, listed or not.
    expect(board.totals.turns).toBe(5);
  });
});

describe('buildCostBoard by model', () => {
  it('groups by provider and model, most expensive first', () => {
    const board = buildCostBoard([
      row({ turn: 1, costUsd: 0.01 }),
      row({ turn: 2, costUsd: 0.01 }),
      row({ turn: 2, provider: 'deepseek', model: 'deepseek-chat', costUsd: 0.05 }),
    ]);
    expect(board.models.map((group) => group.key)).toEqual([
      'deepseek/deepseek-chat',
      'anthropic/claude-sonnet-4-5',
    ]);
    expect(board.models[1]).toMatchObject({ turns: 2, totalTokens: 3000 });
  });

  it('reports a model as partly unpriced when a rate arrived only later', () => {
    const board = buildCostBoard([
      row({ turn: 1, provider: 'ollama', model: 'llama3', costUsd: 0, priced: false }),
      row({ turn: 2, provider: 'ollama', model: 'llama3', costUsd: 0.02 }),
    ]);
    expect(board.models[0]).toMatchObject({
      key: 'ollama/llama3',
      costUsd: 0.02,
      unpricedTokens: 1500,
    });
  });
});

describe('buildCostBoard by work', () => {
  it('splits nested work by agent type and keeps the main model first', () => {
    const board = buildCostBoard([
      row({ turn: 1 }),
      row({ turn: 1, scope: 'subagent', agentType: 'explore', costUsd: 0.08 }),
      row({ turn: 1, scope: 'subagent', agentType: 'plan', costUsd: 0.02 }),
    ]);
    expect(board.work.map((group) => group.key)).toEqual([
      'main',
      'subagent:explore',
      'subagent:plan',
    ]);
    expect(board.work[1]?.label).toBe('Subagent: explore');
    expect(board.work[0]?.costUsd).toBe(0.01);
  });

  it('names lines with no agent type nested work instead of an empty label', () => {
    const board = buildCostBoard([row({ turn: 1, scope: 'subagent', agentType: '' })]);
    expect(board.work[0]).toMatchObject({ key: 'subagent:', label: 'Nested work' });
  });
});
