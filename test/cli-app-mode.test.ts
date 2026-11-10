import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import type { PermissionMode } from '../src/tools/types.js';
import { type CliScenario, cliScenario } from './support/cli-app.js';

/**
 * Which tools need asking, changed from the keyboard. The four modes used to be
 * reachable only as a start-up flag, so this is the screen where cake's own
 * description of them is held to the engine's behaviour: every case below
 * switches with /mode and then runs a real turn.
 */

let scene: CliScenario | null = null;

afterEach(async () => {
  // Unmounting closes the database the app was handed, so assertions about the
  // files and the frames come first.
  scene?.close();
  if (scene) await rm(scene.dir, { recursive: true, force: true });
  scene = null;
});

function usage(input: number, output: number) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/**
 * The two requests one tool-calling turn makes: ask for the tool, then answer.
 * `offered` collects the tool names each request actually put in front of the
 * model, which is how a mode that takes a tool away is told apart from one that
 * only refuses it later.
 */
function callsThenAnswers(
  toolName: string,
  input: unknown,
  finalText: string,
  offered: string[][],
) {
  let request = 0;
  return new MockLanguageModelV4({
    doStream: async ({ tools }) => {
      offered.push((tools ?? []).map((tool) => tool.name).sort());
      if (request++ === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName,
                input: JSON.stringify(input),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: usage(10, 3),
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: finalText },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: usage(12, 4),
            },
          ],
        }),
      };
    },
  });
}

const CARD = '[y/Enter] allow';

/** True once a card has been painted, even if the turn answered it and moved on. */
function asked(): boolean {
  return scene?.app.frames().some((frame) => frame.includes(CARD)) ?? false;
}

async function seed(dir: string, name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, text, 'utf8');
  return file;
}

/** Start in default, then switch — so the mode under test got there through /mode. */
async function inMode(mode: PermissionMode, model: MockLanguageModelV4): Promise<CliScenario> {
  scene = await cliScenario(model);
  await scene.app.submit(`/mode ${mode}`);
  await scene.app.waitFor(`mode → ${mode}`);
  return scene;
}

describe('/mode in the terminal app', () => {
  it('lists the modes and what each one lets through when asked for none', async () => {
    scene = await cliScenario();
    await scene.app.submit('/mode');
    await scene.app.waitFor('mode: default');
    const frame = scene.app.frame();
    expect(frame).toContain('Read-only: file reads and searches, nothing else');
    expect(frame).toContain('Writes run freely; shell still needs approval');
    expect(frame).toContain('Everything runs without asking');
  });

  it('names the mode it switched to, on the line that says what is in force', async () => {
    scene = await cliScenario();
    expect(scene.app.frame()).toContain('mode=default');
    await scene.app.submit('/mode acceptEdits');
    await scene.app.waitFor('mode → acceptEdits');
    expect(scene.app.frame()).toContain('mode=acceptEdits');
  });

  it('refuses a mode it does not have, and keeps running in the one it was in', async () => {
    const offered: string[][] = [];
    scene = await cliScenario(
      callsThenAnswers('write', { path: 'a.txt', content: 'after\n' }, 'done', offered),
    );
    const { app, dir } = scene;
    const file = await seed(dir, 'a.txt', 'before\n');

    await app.submit('/mode acceptEdits');
    await app.waitFor('mode → acceptEdits');
    await app.submit('/mode everything');
    await app.waitFor('unknown mode "everything"');
    expect(app.frame()).toContain('plan | default | acceptEdits | yolo');
    // The screen still says the mode the typo did not change...
    expect(app.frame()).toContain('mode=acceptEdits');
    // ...and the next turn really still runs in it: the write is offered and
    // needs no card.
    await app.submit('rewrite a.txt');
    await app.waitFor('done');
    expect(offered.at(-1)).toContain('write');
    expect(asked()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('after\n');
  });

  it('starts in the mode the flag asked for', async () => {
    const offered: string[][] = [];
    scene = await cliScenario(
      callsThenAnswers('write', { path: 'a.txt', content: 'after\n' }, 'done', offered),
      { mode: 'plan' },
    );
    const { app, dir } = scene;
    const file = await seed(dir, 'a.txt', 'before\n');
    expect(app.frame()).toContain('mode=plan');

    await app.submit('rewrite a.txt');
    await app.waitFor('done');
    expect(offered.at(0)).not.toContain('write');
    expect(asked()).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('before\n');
  });
});

const WRITE_CASES: {
  mode: PermissionMode;
  offered: boolean;
  card: boolean;
  wrote: boolean;
}[] = [
  { mode: 'plan', offered: false, card: false, wrote: false },
  { mode: 'default', offered: true, card: true, wrote: true },
  { mode: 'acceptEdits', offered: true, card: false, wrote: true },
  { mode: 'yolo', offered: true, card: false, wrote: true },
];

describe.each(WRITE_CASES)('a write in $mode mode', ({ mode, offered, card, wrote }) => {
  it('does what the mode itself says it will', async () => {
    const seen: string[][] = [];
    scene = await inMode(
      mode,
      callsThenAnswers('write', { path: 'hello.txt', content: 'after\n' }, 'done', seen),
    );
    const { app, dir } = scene;
    const file = await seed(dir, 'hello.txt', 'before\n');

    await app.submit('rewrite hello.txt');
    if (card) {
      // The only mode of the four that still asks for a write.
      await app.waitFor(CARD);
      await app.press('y');
    }
    await app.waitFor('done');
    expect(seen.at(0)?.includes('write')).toBe(offered);
    expect(asked()).toBe(card);
    expect(await readFile(file, 'utf8')).toBe(wrote ? 'after\n' : 'before\n');
  });
});

const SHELL_CASES: {
  mode: PermissionMode;
  offered: boolean;
  card: boolean;
  ran: boolean;
}[] = [
  { mode: 'plan', offered: false, card: false, ran: false },
  { mode: 'default', offered: true, card: true, ran: true },
  { mode: 'acceptEdits', offered: true, card: true, ran: true },
  { mode: 'yolo', offered: true, card: false, ran: true },
];

describe.each(SHELL_CASES)('a shell command in $mode mode', ({ mode, offered, card, ran }) => {
  it('does what the mode itself says it will', async () => {
    const seen: string[][] = [];
    scene = await inMode(mode, callsThenAnswers('bash', { command: 'echo hi' }, 'done', seen));
    const { app } = scene;

    await app.submit('say hi from the shell');
    if (card) {
      // acceptEdits lets writes through and still asks here, which is the whole
      // difference between it and yolo.
      await app.waitFor(CARD);
      await app.press('y');
    }
    await app.waitFor('done');
    expect(seen.at(0)?.includes('bash')).toBe(offered);
    expect(asked()).toBe(card);
    expect(app.frame().includes('exit code: 0')).toBe(ran);
  });
});

/**
 * A tool that is read for some calls and write for others stays on the table in
 * plan mode, so the refusal the mode's description promises has to happen by
 * name, per call — which is the only way that message is ever reached.
 */
it('refuses the writing half of git by name in plan mode, without asking', async () => {
  const seen: string[][] = [];
  scene = await inMode(
    'plan',
    callsThenAnswers('git', { subcommand: 'commit', message: 'x' }, 'done', seen),
  );
  const { app } = scene;

  await app.submit('commit what is staged');
  await app.waitFor('done');
  expect(seen.at(0)).toContain('git');
  expect(asked()).toBe(false);
  expect(app.frame()).toContain('git (write) is disabled in plan mode');
});

/**
 * The mode a turn is running in also decides what a child agent may be offered,
 * and the terminal has no cards, so the two lines this prints about a child are
 * the only record that one was run at all.
 */
it('gives a general subagent the mode that is in force, and says so on screen', async () => {
  const seen: string[][] = [];
  scene = await inMode(
    'plan',
    callsThenAnswers('agent', { type: 'general', prompt: 'check the readme' }, 'parent done', seen),
  );
  const { app } = scene;

  await app.submit('let a subagent read the readme');
  await app.waitFor('↳ general done');
  // The first request is the parent's, the second is the child working out its
  // own answer, and the last is the parent again — so the child is seen[1].
  expect(seen[0]).toContain('agent');
  expect(seen[1]).not.toContain('agent');
  expect(seen[1]).not.toContain('write');
  expect(seen[1]).toContain('read');
  expect(seen.at(-1)).toContain('agent');
  const frame = app.frame();
  expect(frame).toContain('↳ general agent: check the readme');
  expect(frame).toContain('↳ general done');
});
