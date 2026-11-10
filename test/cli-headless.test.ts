import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ModelMessage, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHeadless } from '../src/cli/headless.js';
import { revertTurn } from '../src/cli/revert.js';
import { CheckpointStore } from '../src/core/checkpoints.js';
import type { PricingOverrides } from '../src/core/pricing.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { ModelProvider } from '../src/providers/types.js';
import { defaultSessionFile, SessionStore } from '../src/session/store.js';
import type { PermissionMode } from '../src/tools/types.js';

/**
 * The scripted entry — `cake -p "…"`, `cake "…"` — has no keyboard and no
 * screen, so its whole contract is which words go to stdout and which to stderr,
 * and what a run that nobody approved leaves behind. That contract used to live
 * inside cli.tsx, which runs main() the moment it is imported, so nothing here
 * could reach it. It lives in src/cli/headless.ts now, with the workspace and
 * the two output streams handed in, and every claim below is one call away.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cake-headless-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** One provider reply: text, a call for a tool, or a failure the SDK reports. */
type Step =
  | { text: string }
  | { tool: { name: string; input: Record<string, unknown> } }
  | { fails: string }
  | { aborts: true };

interface Script {
  model: MockLanguageModelV4;
  /** What each request was asked, as JSON — how a test sees the history. */
  prompts: string[];
  /** How many provider calls have started. */
  calls(): number;
}

function answerStream(text: string) {
  return simulateReadableStream({
    chunks: [
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 'answer' },
      { type: 'text-delta' as const, id: 'answer', delta: text },
      { type: 'text-end' as const, id: 'answer' },
      {
        type: 'finish' as const,
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: usage(80, 5),
      },
    ],
  });
}

function scripted(
  steps: Step[],
  options: { sigintAt?: number; observe?: (call: number, aborted: boolean) => void } = {},
): Script {
  const prompts: string[] = [];
  let call = 0;
  /**
   * The step for this request. A script that runs out answers with text rather
   * than repeating the last step, so a turn that was expected to end after one
   * call cannot quietly loop on it twenty times.
   */
  const stepFor = (index: number): Step => steps[index] ?? { text: '(the script ran out)' };
  const model = new MockLanguageModelV4({
    // The summarizer asks with generateText, so a compressed history needs an
    // answer here too.
    async doGenerate({ prompt, abortSignal }) {
      call += 1;
      prompts.push(JSON.stringify(prompt));
      options.observe?.(call, abortSignal?.aborted === true);
      const step = stepFor(call - 1);
      return {
        content: [{ type: 'text' as const, text: 'text' in step ? step.text : 'summarized' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: usage(30, 4),
        warnings: [],
      };
    },
    async doStream({ prompt, abortSignal }) {
      call += 1;
      prompts.push(JSON.stringify(prompt));
      // Ctrl+C is an event on the process, so a test asks for one the way a
      // terminal sends it — while a provider call is still waiting.
      if (options.sigintAt === call) process.emit('SIGINT', 'SIGINT');
      options.observe?.(call, abortSignal?.aborted === true);
      const step = stepFor(call - 1);
      if ('fails' in step) throw new Error(step.fails);
      if ('aborts' in step) {
        // What the SDK does once the signal it was given has fired: it stops,
        // and the reason is the abort. If nothing aborted, the turn keeps going
        // so the test sees the interruption rather than a scripted assumption.
        if (abortSignal?.aborted) throw new Error('The operation was aborted.');
        return { stream: answerStream('kept going without being interrupted') };
      }
      if ('tool' in step) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              {
                type: 'tool-call' as const,
                toolCallId: `call-${call}`,
                toolName: step.tool.name,
                input: JSON.stringify(step.tool.input),
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
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start' as const, warnings: [] },
            { type: 'text-start' as const, id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: step.text },
            { type: 'text-end' as const, id: 'answer' },
            {
              type: 'finish',
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: usage(80, 5),
            },
          ],
        }),
      };
    },
  });
  return { model, prompts, calls: () => call };
}

interface RunResult {
  out: string;
  err: string;
  /** What the process would exit with: the scripted entry reports failure that way. */
  exitCode: number;
  sessionId: string;
  prompts: string[];
  /** SIGINT listeners left behind: a run that keeps one would abort the next job. */
  listenerDelta: number;
}

/** Read the database the run wrote, with the lock taken and released here. */
async function readBack<T>(fn: (store: SessionStore) => T): Promise<T> {
  const store = SessionStore.open(defaultSessionFile(dir));
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/**
 * One scripted run in a real workspace over a real database and a real undo
 * archive, with the two streams collected instead of wired to the terminal.
 */
async function run(
  steps: Step[],
  options: {
    prompt?: string;
    mode?: PermissionMode;
    history?: ModelMessage[];
    pricing?: PricingOverrides;
    maxContext?: number;
    /** Send Ctrl+C while this provider call is waiting. */
    sigintAt?: number;
    observe?: (call: number, aborted: boolean) => void;
  } = {},
): Promise<RunResult> {
  const model = scripted(steps, {
    ...(options.sigintAt ? { sigintAt: options.sigintAt } : {}),
    ...(options.observe ? { observe: options.observe } : {}),
  });
  const provider: ModelProvider = {
    id: 'anthropic',
    label: 'mock',
    defaultModelId: 'claude-sonnet-4-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    languageModel: () => model.model,
    capabilities: () => ({
      toolCalling: true,
      vision: true,
      maxContext: options.maxContext ?? 200_000,
      assumed: false,
    }),
  };
  const registry = new ProviderRegistry().register(provider, 'test-key');
  const store = SessionStore.open(defaultSessionFile(dir));
  const session = store.create({ cwd: dir, provider: 'anthropic', model: 'claude-sonnet-4-5' });
  const out: string[] = [];
  const err: string[] = [];
  const listenerCount = process.listenerCount('SIGINT');
  // The entry reports failure by setting the exit code, so the test owns it for
  // the duration of the call and gives it back afterwards.
  const savedExitCode = process.exitCode;
  process.exitCode = 0;
  await runHeadless({
    cwd: dir,
    registry,
    model: { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    system: 'test system',
    store,
    session,
    history: options.history ?? [],
    prompt: options.prompt ?? 'summarize the readme',
    mode: options.mode ?? 'default',
    rules: { allow: [], deny: [] },
    pricing: options.pricing ?? {},
    checkpoints: CheckpointStore.forWorkspace(dir),
    io: {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    },
  });
  const exitCode = process.exitCode ?? 0;
  process.exitCode = savedExitCode;
  return {
    out: out.join(''),
    err: err.join(''),
    exitCode,
    sessionId: session.id,
    prompts: model.prompts,
    listenerDelta: process.listenerCount('SIGINT') - listenerCount,
  };
}

describe('what the scripted entry prints, and where', () => {
  it('sends the answer to stdout and the meter to stderr', async () => {
    const result = await run([{ text: 'the readme is short' }]);
    expect(result.out).toBe('the readme is short\n');
    // What a script pipes is the answer; the run's own report goes elsewhere.
    expect(result.out).not.toContain('[tokens]');
    expect(result.err).toContain('[tokens] ');
    expect(result.err).not.toContain('the readme is short');
  });

  it('keeps every bracketed line off stdout so a pipe stays clean', async () => {
    const result = await run(
      [{ tool: { name: 'read', input: { path: 'readme.md' } } }, { text: 'read it' }],
      { prompt: 'read readme.md' },
    );
    expect(result.out).toBe('read it\n');
    expect(result.out).not.toMatch(/^\[/m);
    expect(result.err).toContain('[tool] read {"path":"readme.md"}');
    expect(result.err).toMatch(/\[tokens\] in=\d+ out=\d+ cost=/);
    expect(result.err).toContain(`[session] ${result.sessionId}`);
  });

  it('prices the run it billed, and says which session it wrote', async () => {
    const result = await run([{ text: 'ok' }], {
      pricing: { 'anthropic/claude-sonnet': { inputPer1M: 3, outputPer1M: 15 } },
    });
    expect(result.err).toContain(`[session] ${result.sessionId}`);
    expect(result.err).toMatch(/cost=\$0\.\d+/);
    expect(result.out).toBe('ok\n');
  });

  it('names the run log it wrote when tracing is asked for', async () => {
    process.env.CAKE_TRACE = '1';
    try {
      const result = await run([{ text: 'traced' }]);
      const file = result.err.match(/\[trace\] (.+)/)?.[1];
      expect(file).toContain(path.join('.cake', 'logs'));
      const log = await readFile(file as string, 'utf8');
      expect(log).toContain('"type":"finish"');
      expect(log).toContain('"type":"start"');
      // The streamed words are not one line per token: the log records the calls,
      // and the answer arrives as the answer.
      expect(log).not.toContain('"type":"text-delta"');
    } finally {
      delete process.env.CAKE_TRACE;
    }
  });

  it('writes the transcript and the title it was asked for', async () => {
    const result = await run([{ text: 'two paragraphs, one point' }], {
      prompt: 'fix the readme',
    });
    const saved = await readBack((store) => ({
      messages: store.messages(result.sessionId),
      title: store.get(result.sessionId)?.title,
      usage: store.turnUsage(result.sessionId).length,
    }));
    expect(saved.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(saved.messages[0])).toContain('fix the readme');
    expect(saved.title).toBe('fix the readme');
    expect(saved.usage).toBeGreaterThan(0);
  });

  it('sends the history it saved back out on the next run', async () => {
    const first = await run([{ text: 'the parser needs a test' }], { prompt: 'what breaks?' });
    const history = await readBack((store) => store.messages(first.sessionId));
    const second = await run([{ text: 'agreed' }], { prompt: 'and then?', history });
    expect(second.prompts.at(-1)).toContain('the parser needs a test');
    expect(second.prompts.at(-1)).toContain('and then?');
  });
});

/**
 * A parent turn that hands the work to a child, which writes. Four requests:
 * the parent's call, the child's call, the child's answer, the parent's answer.
 */
function childWritesNote(): Step[] {
  return [
    { tool: { name: 'agent', input: { type: 'general', prompt: 'write a note' } } },
    { tool: { name: 'write', input: { path: 'child.md', content: 'from the child\n' } } },
    { text: 'wrote the note' },
    { text: 'the child wrote it' },
  ];
}

describe('approval, with nobody at the keyboard', () => {
  it('refuses a write the mode would have asked about, and says how to allow it', async () => {
    await writeFile(path.join(dir, 'notes.txt'), 'keep\n', 'utf8');
    const result = await run(
      [{ tool: { name: 'write', input: { path: 'notes.txt', content: 'changed\n' } } }],
      { prompt: 'overwrite notes.txt' },
    );
    expect(await readFile(path.join(dir, 'notes.txt'), 'utf8')).toBe('keep\n');
    expect(result.err).toContain(
      '[permission] write needs approval: notes.txt (8 chars) ' +
        '(non-interactive; pass --yes to allow)',
    );
    expect(result.err).toContain('[tool-error] write');
    expect(result.out).not.toContain('needs approval');
  });

  it('lets the same call run when the mode says everything runs', async () => {
    await writeFile(path.join(dir, 'notes.txt'), 'keep\n', 'utf8');
    const result = await run(
      [{ tool: { name: 'write', input: { path: 'notes.txt', content: 'changed\n' } } }],
      { prompt: 'overwrite notes.txt', mode: 'yolo' },
    );
    expect(await readFile(path.join(dir, 'notes.txt'), 'utf8')).toBe('changed\n');
    expect(result.err).not.toContain('[permission]');
  });

  it('hands the mode in force down to a child that writes', async () => {
    const result = await run(childWritesNote(), {
      prompt: 'have a child write a note',
      mode: 'yolo',
    });
    expect(result.err).not.toContain('[permission]');
    expect(await readFile(path.join(dir, 'child.md'), 'utf8')).toBe('from the child\n');
    expect(result.out).toBe('the child wrote it\n');
  });

  it('refuses the same call when the child inherits a mode that asks', async () => {
    const result = await run(childWritesNote(), { prompt: 'have a child write a note' });
    expect(result.err).toContain('[permission] write needs approval');
    await expect(readFile(path.join(dir, 'child.md'), 'utf8')).rejects.toThrow();
  });

  it('names what looks destructive in the refusal', async () => {
    const result = await run([{ tool: { name: 'bash', input: { command: 'rm -rf build' } } }]);
    expect(result.err).toContain('[danger: recursive force delete (rm -rf)]');
    expect(result.err).toContain('--yes to allow');
    expect(result.out).toBe('(the script ran out)\n');
  });

  it('says what an @mention attached, and what it did not', async () => {
    await writeFile(path.join(dir, 'readme.md'), '# project\n', 'utf8');
    const result = await run([{ text: 'read both' }], {
      prompt: 'compare @readme.md with @missing.md',
    });
    expect(result.err).toContain('[files] attached readme.md');
    expect(result.err).toContain('[files] not attached');
    expect(result.err).toContain('missing.md');
    // The file is in the request, not only named in it.
    expect(result.prompts.at(-1)).toContain('# project');
  });

  it('says which child agent ran, and what it cost', async () => {
    const result = await run([
      { tool: { name: 'agent', input: { type: 'explore', prompt: 'find the parser' } } },
      // The child answers from the same script, one request before the parent.
      { text: 'src/parser.ts' },
      { text: 'the parser is in src/parser.ts' },
    ]);
    expect(result.err).toContain('[subagent] explore started: find the parser');
    expect(result.err).toContain('[subagent] explore done (');
    expect(result.out).toBe('the parser is in src/parser.ts\n');
  });

  it('runs a read without asking, in any mode', async () => {
    await writeFile(path.join(dir, 'readme.md'), '# project\n', 'utf8');
    const result = await run(
      [{ tool: { name: 'read', input: { path: 'readme.md' } } }, { text: 'one heading' }],
      { mode: 'plan' },
    );
    expect(result.err).not.toContain('[permission]');
    expect(result.err).toContain('[tool] read');
    expect(result.out).toBe('one heading\n');
  });

  it('never offers a tool the mode cannot run, so the answer says so', async () => {
    const result = await run(
      [{ tool: { name: 'bash', input: { command: 'echo hi' } } }, { text: 'cannot' }],
      { mode: 'plan' },
    );
    expect(result.err).toContain('[tool-error] bash');
    expect(result.err).not.toContain('[permission] bash');
    expect(result.out).toBe('cannot\n');
  });
});

describe('a run that does not finish', () => {
  it('reports a provider failure on stderr and exits 1', async () => {
    const result = await run([{ fails: 'mock provider refused' }]);
    expect(result.err).toContain('[error] mock provider refused');
    expect(result.out).toBe('\n');
    expect(result.exitCode).toBe(1);
  });

  it('leaves the session with nothing saved when the turn never answered', async () => {
    const result = await run([{ fails: 'mock provider refused' }], { prompt: 'do the thing' });
    expect(await readBack((store) => store.messages(result.sessionId))).toEqual([]);
  });

  it('stops the turn when the terminal asks it to, and takes the listener with it', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
    const seen: Array<{ call: number; aborted: boolean }> = [];
    const result = await run(
      [
        { tool: { name: 'write', input: { path: 'a.txt', content: 'two\n' } } },
        { aborts: true },
        { text: 'never reached' },
      ],
      {
        prompt: 'change a.txt then keep going',
        mode: 'yolo',
        sigintAt: 2,
        observe: (call, aborted) => seen.push({ call, aborted }),
      },
    );
    // The signal reaches the provider call that is in flight, which is what
    // makes the answer stop rather than the process.
    expect(seen).toEqual([
      { call: 1, aborted: false },
      { call: 2, aborted: true },
    ]);
    expect(result.out).toBe('\n');
    expect(result.err).toContain('[tokens] in=0 out=0');
    // An interrupted run is not reported as a failed one: the entry reserves
    // exit 1 for a turn that ended in an error, and this ended because someone
    // asked it to.
    expect(result.exitCode).toBe(0);
    // The listener is installed for the run and removed after it, so a second
    // Ctrl+C in the same process cannot abort a turn that already finished.
    expect(result.listenerDelta).toBe(0);
  });

  it('leaves an interrupted turn undoable, with the ask it was given', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(dir);
    const result = await run(
      [{ tool: { name: 'write', input: { path: 'a.txt', content: 'two\n' } } }, { aborts: true }],
      {
        prompt: 'change a.txt and say more',
        mode: 'yolo',
        sigintAt: 2,
      },
    );
    expect(result.out).toBe('\n');
    // The write landed before the interrupt, so the undo has to cover it.
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    const asks = await readBack((store) => store.checkpointAsks(dir));
    expect([...asks.values()]).toContain('change a.txt and say more');
    const undone = await revertTurn(checkpoints, '1', asks);
    expect(undone).toContain('turn 1 reverted');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('keeps a failed turn undoable, and says what it was asked to do', async () => {
    await writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
    const checkpoints = CheckpointStore.forWorkspace(dir);
    const result = await run(
      [
        { tool: { name: 'write', input: { path: 'a.txt', content: 'two\n' } } },
        { fails: 'mock provider refused' },
      ],
      { prompt: 'rewrite a.txt', mode: 'yolo' },
    );
    expect(result.exitCode).toBe(1);
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('two\n');

    const asks = await readBack((store) => store.checkpointAsks(dir));
    expect([...asks.values()]).toContain('rewrite a.txt');
    const listed = await revertTurn(checkpoints, 'list', asks);
    expect(listed).toContain('rewrite a.txt');
    expect(listed).toContain('a.txt');

    const undone = await revertTurn(checkpoints, '1', asks);
    expect(undone).toContain('turn 1 reverted');
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
  });
});

describe('the budget a scripted run compresses against', () => {
  const longHistory = () =>
    Array.from({ length: 10 }, (_unused, index) => [
      { role: 'user' as const, content: `question ${index} ${'x'.repeat(2000)}` },
      { role: 'assistant' as const, content: `answer ${index} ${'y'.repeat(2000)}` },
    ]).flat();

  it('says so when the history is compressed to fit', async () => {
    // Two requests: the summarizer's, then the turn's.
    const result = await run([{ text: 'a summary of the older turns' }, { text: 'still here' }], {
      history: longHistory(),
      maxContext: 4_000,
    });
    expect(result.err).toContain('[context] older history compressed');
    expect(result.out).toBe('still here\n');
    // The summary stands in for the turns it replaced, in the request and only
    // in it: the database still holds the whole conversation.
    expect(result.prompts.at(-1)).toContain('a summary of the older turns');
    expect(result.prompts.at(-1)).not.toContain('question 0');
  });

  it('leaves a history that fits alone', async () => {
    const result = await run([{ text: 'still here' }], {
      history: longHistory(),
      maxContext: 200_000,
    });
    expect(result.err).not.toContain('compress');
    expect(result.prompts.at(-1)).toContain('question 0');
  });
});
