import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function toolStep(toolCallId: string, toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(50, 10),
        },
      ],
    }),
  };
}

function textStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 't' },
        { type: 'text-delta' as const, id: 't', delta: text },
        { type: 'text-end' as const, id: 't' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(80, 5),
        },
      ],
    }),
  };
}

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'cake-e2e-'));
  await writeFile(
    path.join(cwd, 'math.js'),
    'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n',
    'utf8',
  );
  await writeFile(
    path.join(cwd, 'check.js'),
    [
      "const { add } = require('./math.js');",
      'if (add(2, 3) !== 5) {',
      "  console.error('FAIL:', add(2, 3));",
      '  process.exit(1);',
      '}',
      "console.log('PASS');",
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('end-to-end fix-bug loop', () => {
  it('reads, edits, verifies with a real command, and reports', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        toolStep('c1', 'read', { path: 'math.js' }),
        toolStep('c2', 'edit', {
          path: 'math.js',
          old_string: 'return a - b;',
          new_string: 'return a + b;',
        }),
        toolStep('c3', 'bash', { command: 'node check.js', description: 'verify the fix' }),
        textStep('Fixed add() and verified it with node check.js.'),
      ],
    });

    const provider: ModelProvider = {
      id: 'anthropic',
      label: 'mock',
      defaultModelId: 'claude-sonnet-4-5',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      languageModel: () => model,
      capabilities: () => ({ toolCalling: true, vision: false, maxContext: 200_000 }),
    };
    const registry = new ProviderRegistry().register(provider, 'test-key');

    const events: AgentEvent[] = [];
    const ctx: ToolContext = { cwd, tasks: [], askPermission: async () => 'allow', log: () => {} };
    const result = await runAgent(
      {
        model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
        tools: buildToolSet(createDefaultTools(), ctx, 'yolo'),
        messages: [{ role: 'user', content: 'add() returns the wrong value; fix it and verify' }],
        onEvent: (event) => events.push(event),
      },
      registry,
    );

    expect(await readFile(path.join(cwd, 'math.js'), 'utf8')).toContain('return a + b;');

    const calls = events.flatMap((event) => (event.type === 'tool-call' ? [event.toolName] : []));
    expect(calls).toEqual(['read', 'edit', 'bash']);

    const bashResult = events.find(
      (event) => event.type === 'tool-result' && event.toolName === 'bash',
    ) as { output: string };
    expect(bashResult.output).toContain('exit code: 0');
    expect(bashResult.output).toContain('PASS');

    expect(result.text).toBe('Fixed add() and verified it with node check.js.');
  });
});
