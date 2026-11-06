import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/core/agent.js';
import type { AgentEvent, TokenUsage } from '../src/core/events.js';
import { createAgentTool } from '../src/orchestration/tool.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';
import { bashTool } from '../src/tools/bash.js';
import { readTool } from '../src/tools/read.js';
import { buildToolSet } from '../src/tools/registry.js';
import type { CakeTool, NestedUsage, ToolContext } from '../src/tools/types.js';
import { writeTool } from '../src/tools/write.js';

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function stream(chunks: unknown[]): { stream: ReadableStream<never> } {
  const result = { stream: simulateReadableStream({ chunks: chunks as never }) };
  return result as unknown as { stream: ReadableStream<never> };
}

function textStream(text: string, input: number, output: number) {
  return stream([
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: undefined },
      usage: usage(input, output),
    },
  ]);
}

function toolCallStream(name: string, input: unknown, id: string) {
  return stream([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: usage(10, 2),
    },
  ]);
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

const baseTools = [readTool, writeTool, bashTool] as CakeTool[];

let cwd: string;
let events: AgentEvent[];
let recorded: Array<{ usage: TokenUsage; costUsd: number; source?: NestedUsage }>;

function context(callId?: string): ToolContext {
  return {
    cwd,
    tasks: [],
    askPermission: async () => 'allow',
    log: () => {},
    ...(callId === undefined ? {} : { callId }),
    onUsage: (usage, costUsd, source) => recorded.push({ usage, costUsd, source }),
  };
}

function agentOptions(model: MockLanguageModelV4, tools: CakeTool[] = baseTools) {
  return {
    registry: registryFor(model),
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    systemBase: 'Base instructions.',
    tools,
    mode: 'default' as const,
    rules: { allow: [], deny: [] },
    onEvent: (event: AgentEvent) => events.push(event),
  };
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-subagent-'));
  events = [];
  recorded = [];
  await writeFile(path.join(cwd, 'note.txt'), 'alpha content\n', 'utf8');
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('subagents', () => {
  it('runs explore read-only with an isolated context and reports usage', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('read', { path: 'note.txt' }, 'read-1'),
        textStream('Found alpha in note.txt.', 20, 3),
      ],
    });
    const tool = createAgentTool(agentOptions(model));

    const output = await tool.execute({ type: 'explore', prompt: 'where is alpha?' }, context());

    expect(output).toContain('[explore agent]');
    expect(output).toContain('Found alpha in note.txt.');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.usage).toEqual({ inputTokens: 30, outputTokens: 5, totalTokens: 35 });
    // The source names which child spent it, so the board can bill that model.
    expect(recorded[0]?.source).toMatchObject({
      agentType: 'explore',
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    });

    const firstCall = model.doStreamCalls[0];
    expect(firstCall?.prompt[0]).toMatchObject({ role: 'system' });
    expect(JSON.stringify(firstCall?.prompt[0])).toContain('Subagent: explore');
    expect(firstCall?.prompt).toHaveLength(2);
    expect(JSON.stringify(firstCall?.prompt[1])).toContain('where is alpha?');

    const toolNames = (firstCall?.tools ?? []).map((item) => item.name);
    expect(toolNames).toEqual(['read']);

    expect(events.filter((event) => event.type === 'subagent-start')).toHaveLength(1);
    const end = events.find((event) => event.type === 'subagent-end');
    expect(end).toMatchObject({ agentType: 'explore', text: 'Found alpha in note.txt.' });
  });

  it('ties every child call to the agent call that spawned it', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('read', { path: 'note.txt' }, 'child-read-1'),
        textStream('Found it.', 9, 2),
      ],
    });
    const tool = createAgentTool(agentOptions(model));

    await tool.execute({ type: 'explore', prompt: 'where is alpha?' }, context('agent-call-1'));

    const start = events.find((event) => event.type === 'subagent-start');
    expect(start).toMatchObject({ callId: 'agent-call-1', agentType: 'explore' });

    const childCall = events.find(
      (event) => event.type === 'tool-call' && event.toolName === 'explore:read',
    );
    expect(childCall).toMatchObject({
      callId: 'agent-call-1/child-read-1',
      agentCallId: 'agent-call-1',
    });

    const childResult = events.find(
      (event) => event.type === 'tool-result' && event.toolName === 'explore:read',
    );
    expect(childResult).toMatchObject({ callId: 'agent-call-1/child-read-1' });
  });

  it('lets a general subagent write under the parent permission mode', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('write', { path: 'out.txt', content: 'written\n' }, 'write-1'),
        textStream('Wrote out.txt.', 12, 2),
      ],
    });
    const tool = createAgentTool(agentOptions(model));

    const output = await tool.execute({ type: 'general', prompt: 'create out.txt' }, context());

    expect(output).toContain('[general agent]');
    expect(output).toContain('Wrote out.txt.');
    expect(await readFile(path.join(cwd, 'out.txt'), 'utf8')).toBe('written\n');

    const firstCall = model.doStreamCalls[0];
    const toolNames = (firstCall?.tools ?? []).map((item) => item.name);
    expect(toolNames).toEqual(['read', 'write', 'bash']);
    expect(
      events.some((event) => event.type === 'tool-call' && event.toolName === 'general:write'),
    ).toBe(true);
  });

  it('never gives children the agent tool', async () => {
    const model = new MockLanguageModelV4({
      doStream: [textStream('Nothing to do.', 5, 1)],
    });
    const options = agentOptions(model);
    const agentTool = createAgentTool(options);
    const nested = createAgentTool({ ...options, tools: [...baseTools, agentTool] });

    await nested.execute({ type: 'general', prompt: 'delegate further' }, context());

    const toolNames = (model.doStreamCalls[0]?.tools ?? []).map((item) => item.name);
    expect(toolNames).not.toContain('agent');
  });

  it('runs multiple agent calls from one parent turn and forwards each summary', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        stream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'a1',
            toolName: 'agent',
            input: JSON.stringify({ type: 'explore', prompt: 'find alpha' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'a2',
            toolName: 'agent',
            input: JSON.stringify({ type: 'explore', prompt: 'find beta' }),
          },
          {
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: usage(15, 3),
          },
        ]),
        textStream('Found alpha.', 8, 2),
        textStream('Found beta.', 9, 2),
        textStream('Both subagents finished.', 7, 2),
      ],
    });
    const registry = registryFor(model);
    const options = {
      registry,
      model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
      systemBase: 'Base instructions.',
      tools: [readTool] as CakeTool[],
      mode: 'plan' as const,
      rules: { allow: [], deny: [] },
      onEvent: (event: AgentEvent) => events.push(event),
    };
    const tools = buildToolSet([...options.tools, createAgentTool(options)], context(), 'plan');

    const result = await runAgent(
      {
        model: options.model,
        system: 'Base instructions.',
        tools,
        messages: [{ role: 'user', content: 'search both' }],
        onEvent: (event) => events.push(event),
      },
      registry,
    );

    expect(result.text).toBe('Both subagents finished.');
    const summaries = result.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.stringify(message));
    expect(summaries.join('\n')).toContain('Found alpha.');
    expect(summaries.join('\n')).toContain('Found beta.');
    expect(events.filter((event) => event.type === 'subagent-start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'subagent-end')).toHaveLength(2);
    expect(recorded.map((entry) => entry.usage.totalTokens).sort()).toEqual([10, 11]);
  });
});
