import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliScenario, cliScenario } from './support/cli-app.js';

/**
 * One turn, end to end, in the terminal app: the model asks for a write, the
 * person at the keyboard answers, and the file either changes or does not. The
 * approval card is the only place cake asks permission in the CLI, so the keys
 * it answers to are the contract this test holds.
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

/** The two requests one writing turn makes: ask for the tool, then answer. */
function writesThenAnswers(target: string, content: string, finalText: string) {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'write',
              input: JSON.stringify({ path: target, content }),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage: usage(10, 3),
            },
          ],
        }),
      },
      {
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
      },
    ],
  });
}

async function seed(dir: string, name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, text, 'utf8');
  return file;
}

describe('a turn the terminal app has to approve', () => {
  it('stops for the card, and writes when the keyboard says yes', async () => {
    scene = await cliScenario(writesThenAnswers('hello.txt', 'after\n', 'Wrote it.'));
    const { app, dir } = scene;
    const file = await seed(dir, 'hello.txt', 'before\n');

    await app.submit('rewrite hello.txt');
    await app.waitFor('approval');
    // The card names the file it is about to touch, before anything is touched.
    expect(app.frame()).toContain('hello.txt');
    expect(await readFile(file, 'utf8')).toBe('before\n');

    await app.press('y');
    await app.waitFor('Wrote it.');
    expect(await readFile(file, 'utf8')).toBe('after\n');
    // The run is on screen and the question is off it.
    expect(app.frame()).toContain('write');
    expect(app.frame()).not.toContain('[y/Enter] allow');
  });

  it('takes Enter as yes', async () => {
    scene = await cliScenario(writesThenAnswers('a.txt', 'entered\n', 'done'));
    const { app, dir } = scene;
    const file = await seed(dir, 'a.txt', 'before\n');

    await app.submit('rewrite a.txt');
    await app.waitFor('approval');
    await app.press('\r');
    await app.waitFor('done');
    expect(await readFile(file, 'utf8')).toBe('entered\n');
  });

  it('takes Escape as no, and leaves the file alone', async () => {
    scene = await cliScenario(writesThenAnswers('b.txt', 'never\n', 'refused'));
    const { app, dir } = scene;
    const file = await seed(dir, 'b.txt', 'before\n');

    await app.submit('rewrite b.txt');
    await app.waitFor('approval');
    await app.press('\x1b');
    await app.waitFor('refused');
    // A no is a no: the file never moved, and the reason is on screen.
    expect(await readFile(file, 'utf8')).toBe('before\n');
    expect(app.frame()).toContain('denied');
  });

  it('holds the keyboard until the turn it is running is over', async () => {
    scene = await cliScenario(writesThenAnswers('hello.txt', 'after\n', 'Wrote it.'));
    const { app, dir } = scene;
    await seed(dir, 'hello.txt', 'before\n');

    await app.submit('rewrite hello.txt');
    await app.waitFor('approval');
    await app.press('y');
    // The hint is on screen while the turn runs, and the keys typed under it are
    // not queued: the next line only lands once the app takes input again.
    expect(app.frame()).toContain('(working');
    await app.press('/');
    await app.press('x');
    await app.waitFor('Wrote it.');
    await app.ready();
    expect(app.frame()).not.toContain('(working');
    expect(app.frame()).not.toContain('> /x');
  });

  it('gives back what an approved write changed, when /revert is asked', async () => {
    scene = await cliScenario(writesThenAnswers('hello.txt', 'after\n', 'Wrote it.'));
    const { app, dir } = scene;
    const file = await seed(dir, 'hello.txt', 'before\n');

    await app.submit('rewrite hello.txt');
    await app.waitFor('approval');
    await app.press('y');
    await app.waitFor('Wrote it.');
    expect(await readFile(file, 'utf8')).toBe('after\n');

    // The archive knows the question that opened it, because the app named it as
    // the turn closed. The ask is on screen from the transcript already, so the
    // row the list prints — number, time, then the words — is what proves it.
    await app.submit('/revert list');
    await app.waitFor('recorded turn');
    expect(app.frame()).toMatch(/1\s+\d{2}:\d{2}\s+rewrite hello\.txt/);

    await app.submit('/revert 1');
    await app.waitFor('turn 1 reverted');
    expect(app.frame()).toContain('hello.txt restored');
    expect(await readFile(file, 'utf8')).toBe('before\n');
  });

  it('records nothing to undo for a turn that was never allowed to write', async () => {
    scene = await cliScenario(writesThenAnswers('hello.txt', 'after\n', 'refused'));
    const { app, dir } = scene;
    await seed(dir, 'hello.txt', 'before\n');

    await app.submit('rewrite hello.txt');
    await app.waitFor('approval');
    await app.press('n');
    await app.waitFor('refused');

    await app.submit('/revert list');
    await app.waitFor('no turn has changed a file cake can undo yet');
  });

  it('cancels the turn it is holding on Ctrl+C', async () => {
    scene = await cliScenario(writesThenAnswers('hello.txt', 'after\n', 'never read'));
    const { app, dir } = scene;
    const file = await seed(dir, 'hello.txt', 'before\n');

    await app.submit('rewrite hello.txt');
    await app.waitFor('approval');

    await app.press('\x03');
    await app.waitFor('(cancelled)');
    expect(await readFile(file, 'utf8')).toBe('before\n');
    // The question is taken off the screen with the turn: a card nobody is being
    // asked any more would keep answering a turn that has already gone.
    expect(app.frame()).not.toContain('[y/Enter] allow');
  });
});
