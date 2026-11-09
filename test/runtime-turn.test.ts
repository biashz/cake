import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CheckpointStore } from '../src/core/checkpoints.js';
import type { AgentEvent, TokenUsage } from '../src/core/events.js';
import { imageDataUrl, MAX_IMAGES_PER_TURN } from '../src/core/images.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';
import { runTurn, type TurnNote } from '../src/runtime/turn.js';
import { editTool } from '../src/tools/edit.js';
import { taskTool } from '../src/tools/task.js';
import type { CakeTool, ToolContext } from '../src/tools/types.js';
import { writeTool } from '../src/tools/write.js';

const MODEL = { provider: 'anthropic', modelId: 'claude-sonnet-4-5' } as const;

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function registryFor(model: MockLanguageModelV4, vision = false): ProviderRegistry {
  const provider: ModelProvider = {
    id: 'anthropic',
    label: 'mock',
    defaultModelId: 'claude-sonnet-4-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    languageModel: () => model,
    capabilities: () => ({ toolCalling: true, vision, maxContext: 200_000 }),
  };
  return new ProviderRegistry().register(provider, 'test-key');
}

const PNG_URL = imageDataUrl(Buffer.from('a tiny picture'), 'image/png');
// A real 1x1 PNG, so a mention of it is read as the bytes it claims to be.
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** The SDK accepts the bytes bare or tagged; this reads either. */
function imageBase64Of(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  const tagged = data as { type?: string; data?: unknown };
  return typeof tagged?.data === 'string' ? tagged.data : undefined;
}

/** The content of the last user message the model was actually asked with. */
function lastUserContent(model: MockLanguageModelV4): unknown {
  const call = model.doStreamCalls[0];
  const prompt = call?.prompt ?? [];
  const users = prompt.filter((message) => message.role === 'user');
  return users[users.length - 1]?.content;
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

describe('runTurn checkpoints', () => {
  function turnFor(model: MockLanguageModelV4, overrides: Record<string, unknown> = {}) {
    const { ctx } = context();
    return runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'sys',
      mode: 'yolo',
      rules: { allow: [], deny: [] },
      tools: [writeTool],
      history: [],
      prompt: 'change it',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
      ...overrides,
    });
  }

  it('archives the file a turn changed, so the turn can be undone', async () => {
    await writeFile(path.join(cwd, 'a.ts'), 'original\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(cwd);
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('write', { path: 'a.ts', content: 'rewritten\n' }),
        textStream('done'),
      ],
    });

    await turnFor(model, { checkpoints });
    expect(await readFile(path.join(cwd, 'a.ts'), 'utf8')).toBe('rewritten\n');

    const turns = await checkpoints.list();
    const first = turns[0];
    if (!first) throw new Error('the turn left no checkpoint');
    expect(turns).toHaveLength(1);
    expect(first.entries.map((entry) => entry.path)).toEqual(['a.ts']);

    const report = await checkpoints.rewind(first.id);
    if (!report?.applied) throw new Error('rewind did not apply');
    expect(await readFile(path.join(cwd, 'a.ts'), 'utf8')).toBe('original\n');
  });

  it('archives the paths a mixed write-and-edit turn touched', async () => {
    await writeFile(path.join(cwd, 'a.ts'), 'original\n', 'utf8');
    await writeFile(path.join(cwd, 'b.ts'), 'one\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(cwd);
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('write', { path: 'c.ts', content: 'new file\n' }),
        toolCallStream('edit', { path: 'b.ts', old_string: 'one', new_string: 'two' }),
        textStream('done'),
      ],
    });

    await turnFor(model, { checkpoints, tools: [writeTool, editTool] });
    const turns = await checkpoints.list();
    const first = turns[0];
    if (!first) throw new Error('the turn left no checkpoint');
    expect(first.entries.map((entry) => entry.path)).toEqual(['c.ts', 'b.ts']);

    await checkpoints.rewind(first.id);
    // Each kind of change goes back the way it came: an edit to its old text,
    // a creation to no file at all.
    expect(await readFile(path.join(cwd, 'b.ts'), 'utf8')).toBe('one\n');
    await expect(readFile(path.join(cwd, 'c.ts'), 'utf8')).rejects.toThrow('ENOENT');
  });

  it('keeps one archive per turn, whatever the model did to the same file', async () => {
    await writeFile(path.join(cwd, 'a.ts'), 'first\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(cwd);
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('write', { path: 'a.ts', content: 'second\n' }),
        toolCallStream('write', { path: 'a.ts', content: 'third\n' }),
        textStream('done'),
      ],
    });

    await turnFor(model, { checkpoints });
    const turns = await checkpoints.list();
    const first = turns[0];
    if (!first) throw new Error('the turn left no checkpoint');
    expect(turns).toHaveLength(1);
    expect(first.entries).toHaveLength(1);

    await checkpoints.rewind(first.id);
    // The turn found the file as it was before the first edit, not the middle one.
    expect(await readFile(path.join(cwd, 'a.ts'), 'utf8')).toBe('first\n');
  });

  it('leaves a refused write out of the archive', async () => {
    await writeFile(path.join(cwd, 'a.ts'), 'original\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(cwd);
    const model = new MockLanguageModelV4({
      doStream: [toolCallStream('write', { path: 'a.ts', content: 'no\n' }), textStream('refused')],
    });
    const { ctx } = context();
    const denied: ToolContext = { ...ctx, askPermission: async () => 'deny' };

    await turnFor(model, { checkpoints, ctx: denied, mode: 'default' });
    expect(await readFile(path.join(cwd, 'a.ts'), 'utf8')).toBe('original\n');
    expect(await checkpoints.list()).toEqual([]);
  });

  it('closes the archive when the turn dies part-way through', async () => {
    await writeFile(path.join(cwd, 'a.ts'), 'original\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(cwd);
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) return toolCallStream('write', { path: 'a.ts', content: 'half done\n' });
        throw new Error('provider died mid-turn');
      },
    });

    await expect(turnFor(model, { checkpoints })).rejects.toThrow('provider died mid-turn');
    // The write happened, so the undo has to have been recorded: this is the
    // turn nobody wants to keep.
    const turns = await checkpoints.list();
    const first = turns[0];
    if (!first) throw new Error('a failed turn left no checkpoint');
    expect(await readFile(path.join(cwd, 'a.ts'), 'utf8')).toBe('half done\n');

    await checkpoints.rewind(first.id);
    expect(await readFile(path.join(cwd, 'a.ts'), 'utf8')).toBe('original\n');
  });

  it('records nothing when the run was not told to archive', async () => {
    await writeFile(path.join(cwd, 'a.ts'), 'original\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(cwd);
    const model = new MockLanguageModelV4({
      doStream: [
        toolCallStream('write', { path: 'a.ts', content: 'rewritten\n' }),
        textStream('done'),
      ],
    });

    await turnFor(model);
    expect(await checkpoints.list()).toEqual([]);
  });
});

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

  it('keeps one cost line per model, the session’s own first', async () => {
    const model = new MockLanguageModelV4({
      doStream: [toolCallStream('metered', {}), textStream('Done.')],
    });
    const { ctx } = context();

    const result = await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'be brief',
      mode: 'yolo',
      rules: { allow: [], deny: [] },
      tools: [meteredTool(() => {})],
      history: [],
      prompt: 'go',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    // The main call leads even though the nested one finished first.
    expect(result.lines.map((line) => line.scope)).toEqual(['main', 'subagent']);
    expect(result.lines[0]).toMatchObject({
      model: MODEL,
      usage: { totalTokens: 19 },
      priced: true,
    });
    expect(result.lines[1]).toMatchObject({
      model: MODEL,
      usage: { totalTokens: 10 },
      costUsd: 0.5,
      priced: true,
    });
    expect(result.lines[1]?.agentType).toBeUndefined();
    // The folded totals are the same money, seen from the other side.
    expect(result.lines.reduce((sum, line) => sum + line.costUsd, 0)).toBeCloseTo(
      result.costUsd,
      10,
    );
  });

  it('bills nested work under the model and agent that caused it', async () => {
    const child = { provider: 'deepseek', modelId: 'deepseek-chat' } as const;
    const nestedTool: CakeTool = {
      name: 'metered',
      description: 'reports nested usage from another model',
      permission: 'read',
      inputSchema: z.object({}),
      summarize: () => 'nested',
      matchTarget: () => 'nested',
      async execute(_args, toolCtx) {
        toolCtx.onUsage?.(
          { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 },
          0.28,
          { model: child, agentType: 'Explore' },
        );
        return 'nested';
      },
    };
    const model = new MockLanguageModelV4({
      doStream: [toolCallStream('metered', {}), textStream('Done.')],
    });
    const { ctx } = context();

    const result = await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'sys',
      mode: 'yolo',
      rules: { allow: [], deny: [] },
      tools: [nestedTool],
      history: [],
      prompt: 'go',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(result.lines[1]).toMatchObject({
      model: child,
      scope: 'subagent',
      agentType: 'Explore',
      priced: true,
    });
  });

  it('marks a line unpriced when cake has no rate for that model', async () => {
    // A real provider the registry knows, with a model id no card row answers.
    const mystery = { provider: 'anthropic', modelId: 'claude-mystery-1' } as const;
    const model = new MockLanguageModelV4({
      doStream: [toolCallStream('metered', {}), textStream('Done.')],
    });
    const { ctx } = context();

    const result = await runTurn({
      cwd,
      registry: registryFor(model),
      // A model with no card row: its tokens are counted, its cost is not known.
      model: mystery,
      system: 'sys',
      mode: 'yolo',
      rules: { allow: [], deny: [] },
      tools: [meteredTool(() => {})],
      history: [],
      prompt: 'go',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(result.costUsd).toBe(0.5);
    expect(result.lines.map((line) => line.priced)).toEqual([false, false]);
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

  it('carries the retrieved chunks on the codebase note', async () => {
    await writeFile(
      path.join(cwd, 'alpha.ts'),
      'export function alphaHandler() {\n  return "alpha";\n}\n',
      'utf8',
    );
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const notes: TurnNote[] = [];
    const { ctx } = context();

    await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'sys',
      mode: 'default',
      rules: { allow: [], deny: [] },
      tools: [],
      history: [],
      prompt: 'where is @codebase alphaHandler defined?',
      maxContext: 200_000,
      ctx,
      embedder: {
        id: 'fake-a',
        async embed(texts) {
          return texts.map((text) => (text.includes('alpha') ? [1, 0, 0] : [0, 1, 0]));
        },
      },
      abortSignal: new AbortController().signal,
      onEvent: () => {},
      onNote: (note) => notes.push(note),
    });

    // The renderer builds hit cards from this note, so the chunks must travel on it.
    const codebase = notes.find((note) => note.kind === 'codebase' && note.hits !== undefined);
    expect(codebase?.hits?.[0]?.path).toBe('alpha.ts');
    expect(codebase?.text).toMatch(/^attached \d+ chunks?$/);
    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt ?? []);
    expect(prompt).toContain('<codebase query=');
    expect(prompt).toContain('alphaHandler');
  });

  it('puts an attached image beside the text it belongs to', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStream('seen')] });
    const { ctx } = context();

    await runTurn({
      cwd,
      registry: registryFor(model, true),
      model: MODEL,
      system: 'sys',
      mode: 'default',
      rules: { allow: [], deny: [] },
      tools: [],
      history: [],
      prompt: 'what is in this?',
      images: [PNG_URL],
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    const parts = lastUserContent(model) as Array<{
      type: string;
      text?: string;
      mediaType?: string;
      data?: unknown;
    }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'file']);
    expect(parts[0]?.text).toBe('what is in this?');
    // The picture arrives as itself: its own bytes, tagged with its type.
    expect(parts[1]?.mediaType).toBe('image/png');
    expect(imageBase64Of(parts[1]?.data)).toBe('YSB0aW55IHBpY3R1cmU=');
  });

  it('reads a @mentioned image as an image, not as decoded text', async () => {
    await writeFile(path.join(cwd, 'diagram.png'), PNG_BYTES);
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const notes: TurnNote[] = [];
    const { ctx } = context();

    await runTurn({
      cwd,
      registry: registryFor(model, true),
      model: MODEL,
      system: 'sys',
      mode: 'default',
      rules: { allow: [], deny: [] },
      tools: [],
      history: [],
      prompt: 'what does @diagram.png show?',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
      onNote: (note) => notes.push(note),
    });

    const parts = lastUserContent(model) as Array<{ type: string; text?: string }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'file']);
    expect((parts[1] as { mediaType?: string }).mediaType).toBe('image/png');
    // The prompt keeps the words as typed; only the attachment was added.
    expect(parts[0]?.text).toBe('what does @diagram.png show?');
    expect(notes).toContainEqual({ kind: 'files', text: 'attached diagram.png' });
  });

  it('sends one picture once, even when a paste and a mention are the same file', async () => {
    await writeFile(path.join(cwd, 'diagram.png'), PNG_BYTES);
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const { ctx } = context();

    await runTurn({
      cwd,
      registry: registryFor(model, true),
      model: MODEL,
      system: 'sys',
      mode: 'default',
      rules: { allow: [], deny: [] },
      tools: [],
      history: [],
      prompt: 'what does @diagram.png show?',
      // The same bytes, once pasted and once mentioned: two slots, two bills, one picture.
      images: [imageDataUrl(PNG_BYTES, 'image/png')],
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    const parts = lastUserContent(model) as Array<{ type: string }>;
    expect(parts.map((part) => part.type)).toEqual(['text', 'file']);
  });

  it('refuses to spend a turn on a model that cannot read images', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const { ctx } = context();

    await expect(
      runTurn({
        cwd,
        registry: registryFor(model),
        model: MODEL,
        system: 'sys',
        mode: 'default',
        rules: { allow: [], deny: [] },
        tools: [],
        history: [],
        prompt: 'look at this',
        images: [PNG_URL],
        maxContext: 200_000,
        ctx,
        abortSignal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow(/cannot read images/);

    // Refused before the call, not after the bill.
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('refuses a turn carrying more images than the caps allow', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const { ctx } = context();

    await expect(
      runTurn({
        cwd,
        registry: registryFor(model, true),
        model: MODEL,
        system: 'sys',
        mode: 'default',
        rules: { allow: [], deny: [] },
        tools: [],
        history: [],
        prompt: 'five at once',
        images: Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, () => PNG_URL),
        maxContext: 200_000,
        ctx,
        abortSignal: new AbortController().signal,
        onEvent: () => {},
      }),
    ).rejects.toThrow(/At most 4 images per turn/);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it('sends only the typed words when the turn has no attachments', async () => {
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
    const { ctx } = context();

    await runTurn({
      cwd,
      registry: registryFor(model),
      model: MODEL,
      system: 'sys',
      mode: 'default',
      rules: { allow: [], deny: [] },
      tools: [],
      history: [],
      prompt: 'no attachments',
      maxContext: 200_000,
      ctx,
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    });

    // The SDK flattens a string prompt into one text part, so what is provable
    // here is that an unattached turn carries no picture and no file blocks.
    expect(lastUserContent(model)).toEqual([{ type: 'text', text: 'no attachments' }]);
  });
});
