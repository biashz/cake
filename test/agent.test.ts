import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/core/agent.js';
import type { AgentEvent } from '../src/core/events.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';
import { buildToolSet, createDefaultTools } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

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

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-agent-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runAgent multi-step tool loop', () => {
  it('executes a tool call, threads history, and streams the final answer', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'write',
                input: JSON.stringify({ path: 'note.txt', content: 'hello from tool' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: usage(12, 4),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Done.' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: usage(20, 3),
              },
            ],
          }),
        },
      ],
    });

    const events: AgentEvent[] = [];
    const ctx: ToolContext = { cwd, tasks: [], askPermission: async () => 'allow', log: () => {} };
    const result = await runAgent(
      {
        model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
        tools: buildToolSet(createDefaultTools(), ctx, 'yolo'),
        messages: [{ role: 'user', content: 'write a note' }],
        onEvent: (event) => events.push(event),
      },
      registryFor(model),
    );

    expect(await readFile(path.join(cwd, 'note.txt'), 'utf8')).toBe('hello from tool');
    expect(result.text).toBe('Done.');
    expect(events.some((event) => event.type === 'tool-call' && event.toolName === 'write')).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'tool-result' &&
          event.toolName === 'write' &&
          String(event.output).includes('Wrote'),
      ),
    ).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 32, outputTokens: 7, totalTokens: 39 });

    const roles = result.messages.map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('surfaces a denied tool as a tool-error without aborting the run', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-2',
                toolName: 'bash',
                input: JSON.stringify({ command: 'echo nope' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: usage(5, 2),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't2' },
              { type: 'text-delta', id: 't2', delta: 'Skipped.' },
              { type: 'text-end', id: 't2' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: usage(8, 2),
              },
            ],
          }),
        },
      ],
    });

    const events: AgentEvent[] = [];
    const ctx: ToolContext = { cwd, tasks: [], askPermission: async () => 'deny', log: () => {} };
    const result = await runAgent(
      {
        model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
        tools: buildToolSet(createDefaultTools(), ctx, 'default'),
        messages: [{ role: 'user', content: 'run something' }],
        onEvent: (event) => events.push(event),
      },
      registryFor(model),
    );

    expect(result.text).toBe('Skipped.');
    const errors = events.filter((event) => event.type === 'tool-error');
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { error: Error }).error.message)).toMatch(/denied/i);
  });

  it('passes the system prompt as instructions, not as a history message', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'ok' },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: usage(3, 1),
              },
            ],
          }),
        },
      ],
    });

    const result = await runAgent(
      {
        model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
        system: 'be brief',
        messages: [{ role: 'user', content: 'hi' }],
      },
      registryFor(model),
    );

    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt[0]).toMatchObject({ role: 'system', content: 'be brief' });
    expect(prompt.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});
