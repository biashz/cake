import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent, TokenUsage } from '../src/core/events.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';
import { runTurn, type TurnNote } from '../src/runtime/turn.js';
import { taskTool } from '../src/tools/task.js';
import type { CakeTool, ToolContext } from '../src/tools/types.js';

const MODEL = { provider: 'anthropic', modelId: 'claude-sonnet-4-5' } as const;

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function registryFor(model: MockLanguageModelV4): ProviderRegistry {
  const provider: ModelProvider = {
    id: 'anthropic',
    label: 'mock',
    defaultModelId: 'claude-sonnet-4-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    languageModel: () => model,
    capabilities: () => ({ toolCalling: true, vision: false, maxContext: 200_000 }),
  };
  return new ProviderRegistry().register(provider, 'test-key');
}

function toolCallStream(name: string, input: unknown): { stream: ReadableStream<never> } {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'call-1', toolName: name, input: JSON.stringify(input) },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: undefined },
          usage: usage(10, 2),
        },
      ] as never,
    }),
  } as { stream: ReadableStream<never> };
}

function textStream(text: string): { stream: ReadableStream<never> } {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: text },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(5, 2) },
      ] as never,
    }),
  } as { stream: ReadableStream<never> };
}

function meteredTool(report: (usage: TokenUsage, costUsd: number) => void): CakeTool {
  return {
    name: 'metered',
    description: 'reports nested usage',
    permission: 'read',
    inputSchema: z.object({}),
    summarize: () => 'metered',
    matchTarget: () => 'metered',
    async execute(_args, ctx) {
      ctx.onUsage?.({ inputTokens: 4, outputTokens: 6, totalTokens: 10 }, 0.5);
      report({ inputTokens: 4, outputTokens: 6, totalTokens: 10 }, 0.5);
      return 'metered';
    },
  } as CakeTool;
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-turn-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function context(): {
  ctx: ToolContext;
  forwarded: Array<{ usage: TokenUsage; costUsd: number }>;
} {
  const forwarded: Array<{ usage: TokenUsage; costUsd: number }> = [];
  const ctx: ToolContext = {
    cwd,
    tasks: [],
    askPermission: async () => 'allow',
    log: () => {},
    onUsage: (usage, costUsd) => forwarded.push({ usage, costUsd }),
  };
  return { ctx, forwarded };
}

describe('runTurn', () => {
  it('merges nested tool usage into the turn totals and forwards it', async () => {
    const reported: Array<{ usage: TokenUsage; costUsd: number }> = [];
    const model = new MockLanguageModelV4({
      doStream: [toolCallStream('metered', {}), textStream('Done.')],
    });
    const events: AgentEvent[] = [];
    const { ctx, forwarded } = context();

    const result = await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'be brief',
      mode: 'yolo',
      rules: { allow: [], deny: [] },
      tools: [meteredTool((u, c) => reported.push({ usage: u, costUsd: c }))],
      history: [],
      prompt: 'go',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    expect(reported).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 19, outputTokens: 10, totalTokens: 29 });
    expect(result.costUsd).toBeCloseTo(0.500105, 6);
    expect(forwarded).toEqual([
      { usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 }, costUsd: 0.5 },
    ]);
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(events.some((event) => event.type === 'tool-call' && event.toolName === 'metered')).toBe(
      true,
    );
  });

  it('surfaces task tool changes as plan events', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('task', { action: 'add', subject: 'read code' }),
        toolCallStream('task', { action: 'update', id: 1, status: 'in_progress' }),
        textStream('working'),
      ],
    });
    const events: AgentEvent[] = [];
    const { ctx } = context();

    await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'sys',
      mode: 'yolo',
      rules: { allow: [], deny: [] },
      tools: [taskTool],
      history: [],
      prompt: 'plan it',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    });

    const plans = events.filter((event) => event.type === 'plan');
    expect(plans.map((event) => (event.type === 'plan' ? event.tasks : []))).toEqual([
      [{ id: 1, subject: 'read code', status: 'pending' }],
      [{ id: 1, subject: 'read code', status: 'in_progress' }],
    ]);
  });

  it('expands @file mentions before sending the prompt', async () => {
    await writeFile(path.join(cwd, 'note.txt'), 'alpha content\n', 'utf8');
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const events: AgentEvent[] = [];
    const notes: TurnNote[] = [];
    const { ctx } = context();

    const result = await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'sys',
      mode: 'default',
      rules: { allow: [], deny: [] },
      tools: [],
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'ack' },
      ],
      prompt: 'summarize @note.txt',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onNote: (note) => notes.push(note),
    });

    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    const userMessages = prompt.filter((message) => message.role === 'user');
    const userMessage = userMessages[userMessages.length - 1];
    const userContent = JSON.stringify(userMessage?.content);
    expect(userContent).toContain('file path=');
    expect(userContent).toContain('note.txt');
    expect(userContent).toContain('alpha content');
    expect(notes).toContainEqual({ kind: 'files', text: 'attached note.txt' });
    expect(result.text).toBe('ok');
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});
