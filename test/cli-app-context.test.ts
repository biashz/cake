import { rm } from 'node:fs/promises';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliScenario, cliScenario, echoModel, NARROW_MODEL_ID } from './support/cli-app.js';

/**
 * The context budget is a property of the model, and `/model` changes the model
 * mid-session. A run that kept compaction pointed at the window the session
 * started with would either swallow history nobody asked it to swallow, or let
 * one model's window overflow another's. The only place that decision shows up
 * in the terminal is the note a compressed turn leaves, so that is what these
 * tests read.
 */

let scene: CliScenario | null = null;

afterEach(async () => {
  scene?.close();
  if (scene) await rm(scene.dir, { recursive: true, force: true });
  scene = null;
});

/** Ten turns too long for the narrow window and trivial for the wide one. */
function longConversation(): ModelMessage[] {
  return Array.from({ length: 10 }, (_unused, index) => [
    { role: 'user', content: `question ${index}: ${'what changed '.repeat(60)}` },
    { role: 'assistant', content: `answer ${index}: ${'nothing much '.repeat(60)}` },
  ]).flat() as ModelMessage[];
}

describe('the budget a turn compacts against', () => {
  it('leaves a history that fits the current model alone', async () => {
    const asked: string[] = [];
    scene = await cliScenario(echoModel(asked), { initialMessages: longConversation() });
    await scene.app.submit('what did we say so far');
    await scene.app.ready();
    expect(scene.app.frame()).not.toContain('compressed');
    // Everything asked is still in front of the model.
    expect(asked.at(-1)).toContain('question 0');
  });

  it('compacts against the window of the model /model switched to', async () => {
    const asked: string[] = [];
    scene = await cliScenario(echoModel(asked), { initialMessages: longConversation() });
    await scene.app.submit(`/model ${NARROW_MODEL_ID}`);
    await scene.app.waitFor(`model → anthropic/${NARROW_MODEL_ID}`);
    await scene.app.submit('what did we say so far');
    await scene.app.waitFor('context: older history compressed');
    // The summary stands in for the turns it replaced, in the request only.
    expect(asked.at(-1)).toContain('Earlier conversation summary');
    expect(asked.at(-1)).not.toContain('question 0');
  });

  it('starts a session on the narrow model with the same decision', async () => {
    const asked: string[] = [];
    scene = await cliScenario(echoModel(asked), {
      initialMessages: longConversation(),
      modelId: NARROW_MODEL_ID,
    });
    await scene.app.submit('what did we say so far');
    await scene.app.waitFor('context: older history compressed');
    expect(asked.at(-1)).not.toContain('question 0');
  });
});
