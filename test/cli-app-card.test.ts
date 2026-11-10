import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliScenario, cliScenario } from './support/cli-app.js';

/**
 * What the approval card says, read off the screen. The card is the only place
 * the CLI asks a person for permission, so the words on it are the whole of what
 * they have to decide with — naming the wrong tool, or showing no danger for a
 * destructive call, is a real harm even when the keys underneath still work.
 *
 * Stage S6e proved the keys answer; this file proves the card is worth answering.
 */

let scene: CliScenario | null = null;

afterEach(async () => {
  // Unmounting closes the database the app was handed, so assertions about the
  // frames and the files come first.
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
 * The two requests one tool turn makes: ask for the call, then answer after it
 * comes back. The card holds the turn open, so a test reads the frame between
 * them and answers with a key.
 */
function callsTool(
  toolName: string,
  input: Record<string, unknown>,
  finalText: string,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call' as const,
              toolCallId: 'call-1',
              toolName,
              input: JSON.stringify(input),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
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
              finishReason: { unified: 'stop' as const, raw: undefined },
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

describe('what the approval card says', () => {
  it('names the tool, the class it falls in, and what it is about to touch', async () => {
    scene = await cliScenario(callsTool('write', { path: 'card.md', content: 'hello\n' }, 'done'));
    await scene.app.submit('make a card');
    await scene.app.waitFor('approval');
    expect(scene.app.frame()).toContain('approval write (write) → card.md (6 chars)');
  });

  it('shows how big the change is, in lines, before it happens', async () => {
    scene = await cliScenario(
      callsTool('write', { path: 'notes.md', content: 'one\nchanged\n' }, 'done'),
    );
    await seed(scene.dir, 'notes.md', 'one\ntwo\n');
    await scene.app.submit('fix the second line');
    await scene.app.waitFor('· +1');
    expect(scene.app.frame()).toContain('notes.md · +1 −1');
  });

  it('says what looks destructive about a shell call', async () => {
    scene = await cliScenario(callsTool('bash', { command: 'rm -rf build' }, 'cleared'));
    await scene.app.submit('tidy the build folder');
    await scene.app.waitFor('danger:');
    expect(scene.app.frame()).toContain('danger: recursive force delete (rm -rf)');
    // A shell call has no proposed change, so the card says nothing about one
    // rather than inventing `change · +0 −0`.
    expect(scene.app.frame()).not.toContain('· +');
  });

  it('says what looks destructive about a file that holds secrets', async () => {
    scene = await cliScenario(callsTool('write', { path: '.env', content: 'TOKEN=abc\n' }, 'set'));
    await scene.app.submit('set the token');
    await scene.app.waitFor('danger:');
    expect(scene.app.frame()).toContain('danger: sensitive credential file');
  });

  it('does not claim a danger where there is none', async () => {
    scene = await cliScenario(callsTool('write', { path: 'card.md', content: 'hello\n' }, 'done'));
    await scene.app.submit('make a card');
    await scene.app.waitFor('approval');
    expect(scene.app.frame()).not.toContain('danger');
  });

  it('offers exactly the keys that answer it', async () => {
    scene = await cliScenario(callsTool('write', { path: 'card.md', content: 'hello\n' }, 'done'));
    await scene.app.submit('make a card');
    await scene.app.waitFor('approval');
    expect(scene.app.frame()).toContain('[y/Enter] allow · [n/Esc] deny');
  });

  it('holds the destructive call even when everything else runs free', async () => {
    scene = await cliScenario(callsTool('bash', { command: 'rm -rf build' }, 'cleared'), {
      mode: 'yolo',
    });
    await scene.app.submit('tidy the build folder');
    await scene.app.waitFor('approval bash');
    expect(scene.app.frame()).toContain('danger: recursive force delete (rm -rf)');
    // Answering it is a key away, and refusing is the safe one.
    await scene.app.press('n');
    await scene.app.ready();
  });

  it('says nothing about a call that needs no asking', async () => {
    scene = await cliScenario(callsTool('write', { path: 'card.md', content: 'hello\n' }, 'done'), {
      mode: 'yolo',
    });
    await scene.app.submit('make a card');
    await scene.app.ready();
    expect(scene.app.frame()).not.toContain('approval write');
    expect(scene.app.frame()).toContain('done');
  });
});
