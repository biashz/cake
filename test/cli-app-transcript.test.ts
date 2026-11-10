import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Embedder } from '../src/rag/embedder.js';
import { type CliScenario, cliScenario, scriptedTurn } from './support/cli-app.js';

/**
 * What the transcript paints while a turn runs: the call and its result, the
 * notes about what the prompt attached, and the child agents the model sent
 * off. Each of these is a line a person reads to know what just happened to
 * their workspace, so the words are the contract — not the events underneath.
 */

let scene: CliScenario | null = null;

afterEach(async () => {
  scene?.close();
  if (scene) await rm(scene.dir, { recursive: true, force: true });
  scene = null;
});

/** A chunker-friendly workspace: one file whose text the fake embedder finds. */
function alphaEmbedder(): Embedder {
  return {
    id: 'fake-a',
    async embed(texts) {
      return texts.map((text) => (text.includes('alpha') ? [1, 0, 0] : [0, 1, 0]));
    },
  };
}

describe('what the transcript says about a turn', () => {
  it('shows the call as it starts, and the result as it lands', async () => {
    scene = await cliScenario(
      scriptedTurn([
        { tool: { name: 'write', input: { path: 'card.md', content: 'hello\n' } } },
        { text: 'written' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('make a card');
    await scene.app.ready();
    expect(scene.app.frame()).toContain('→ write');
    expect(scene.app.frame()).toContain('← write');
    expect(scene.app.frame()).toContain('Wrote 6 bytes (1 line) to card.md');
  });

  it('cuts a long argument short instead of flooding the screen', async () => {
    scene = await cliScenario(
      scriptedTurn([
        {
          tool: {
            name: 'write',
            input: { path: 'card.md', content: `${'x'.repeat(400)}TAILMARKER` },
          },
        },
        { text: 'written' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('fill the card');
    await scene.app.ready();
    expect(scene.app.frame()).toContain('…');
    expect(scene.app.frame()).not.toContain('TAILMARKER');
  });

  it('marks a call that failed as an error, not a result', async () => {
    scene = await cliScenario(
      scriptedTurn([
        { tool: { name: 'write', input: { path: 'card.md', content: 'hello\n' } } },
        { text: 'never mind' },
      ]),
    );
    await scene.app.submit('make a card');
    await scene.app.waitFor('[y/Enter] allow');
    await scene.app.press('n');
    await scene.app.ready();
    expect(scene.app.frame()).toContain('✗ write');
    expect(scene.app.frame()).toContain('Permission denied by user');
    expect(scene.app.frame()).not.toContain('← write');
  });

  it('says what an @mention attached, and what it did not', async () => {
    scene = await cliScenario(scriptedTurn([{ text: 'read both' }]));
    await writeFile(path.join(scene.dir, 'readme.md'), '# project\n', 'utf8');
    await scene.app.submit('compare @readme.md with @missing.md');
    await scene.app.ready();
    expect(scene.app.frame()).toContain('files: attached readme.md');
    expect(scene.app.frame()).toContain('files: not attached');
    expect(scene.app.frame()).toContain('missing.md');
  });

  it('names the chunks @codebase read, and where they came from', async () => {
    scene = await cliScenario(scriptedTurn([{ text: 'the matcher is here' }]), {
      embedder: alphaEmbedder(),
    });
    await writeFile(path.join(scene.dir, 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
    await scene.app.submit('@codebase alpha');
    await scene.app.ready();
    expect(scene.app.frame()).toContain('codebase: attached 1 chunk');
    expect(scene.app.frame()).toContain('(alpha.ts:1)');
  });

  it('says which child agent ran, and what it cost', async () => {
    scene = await cliScenario(
      scriptedTurn([
        {
          tool: {
            name: 'agent',
            input: { type: 'explore', prompt: 'find the parser' },
          },
        },
        { text: 'src/parser.ts' },
        { text: 'the parser is in src/parser.ts' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('where is the parser?');
    await scene.app.ready();
    expect(scene.app.frame()).toContain('↳ explore agent: find the parser');
    expect(scene.app.frame()).toContain('↳ explore done ·');
    expect(scene.app.frame()).toContain('tokens');
  });

  it('shows the first line that has something on it', async () => {
    // The prompt is what the line quotes, and a model does not keep its blank
    // lines out — the screen has to.
    scene = await cliScenario(
      scriptedTurn([
        {
          tool: {
            name: 'agent',
            input: { type: 'explore', prompt: '\n\nfind the parser\n\nthen report' },
          },
        },
        { text: 'src/parser.ts' },
        { text: 'done' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('where is the parser?');
    await scene.app.ready();
    // The call line quotes the argument as JSON, blank lines and all; the note
    // is the one that has to pick a single line out of it.
    const note = scene.app
      .frame()
      .split('\n')
      .find((line) => line.includes('agent:'));
    expect(note).toContain('↳ explore agent: find the parser');
    expect(note).not.toContain('then report');
    expect(note).not.toContain('{');
  });
});
