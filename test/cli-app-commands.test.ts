import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionMeta } from '../src/session/store.js';
import { type CliScenario, cliScenario, echoModel } from './support/cli-app.js';

/**
 * The interactive command layer, driven through the keys a terminal sends.
 * Nothing here is a stand-in: the session database, the undo archive and the
 * Markdown export are the real ones in a workspace this test owns, so a frame
 * that says the right thing means a person at a terminal would have seen it.
 */

let scene: CliScenario | null = null;

afterEach(async () => {
  // Unmount first: the app closes the database it was given.
  scene?.close();
  if (scene) await rm(scene.dir, { recursive: true, force: true });
  scene = null;
});

async function mount(): Promise<CliScenario> {
  const value = await cliScenario();
  scene = value;
  return value;
}

/** Commands answer in the same tick or the next; give them a beat, not a poll. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function findSession(sessions: SessionMeta[], id: string): SessionMeta {
  const found = sessions.find((session) => session.id === id);
  if (!found) throw new Error(`no session row for ${id}`);
  return found;
}

const parentTranscript: ModelMessage[] = [
  { role: 'user', content: 'the first ask' },
  { role: 'assistant', content: 'the first answer' },
];

describe('the interactive CLI commands', () => {
  it('dispatches every command /help advertises', async () => {
    const { app } = await mount();

    await app.submit('/help');
    await app.waitFor('show this list');
    const advertised = [...app.frame().matchAll(/^\s*\/([a-z]+)/gm)].map(([, name]) => name);
    // The list is only worth reading if it holds what the app answers to.
    expect(advertised.length).toBeGreaterThan(4);

    for (const name of advertised) {
      // /exit is the one command this loop cannot try: it ends the app. Its own
      // test below proves it quits.
      if (name === 'exit') continue;
      await app.submit(`/${name}`);
      await settle();
      expect(app.frames().some((frame) => frame.includes(`unknown command /${name}`))).toBe(false);
    }
  });

  it('reports a command nobody handles as itself', async () => {
    const { app } = await mount();
    await app.submit('/nosuchthing');
    await app.waitFor('unknown command /nosuchthing');
  });

  it('names the model on screen and in the database it resumes from', async () => {
    const { app, store, props } = await mount();

    await app.submit('/model');
    await app.waitFor('model: anthropic/claude-sonnet-4-5');

    await app.submit('/model claude-opus-4-5');
    await app.waitFor('model → anthropic/claude-opus-4-5');
    // Switching only counts if the next `cake -c` comes back on this model.
    expect(store.get(props.session.id)?.model).toBe('claude-opus-4-5');
  });

  it('starts over on a fresh session row, leaving the old one behind', async () => {
    const { app, dir, store, props } = await mount();
    const before = props.session.id;

    await app.submit('/clear');
    await app.waitFor('new session');
    // The header moved to another session, and both rows belong to this workspace.
    await settle();
    const rows = store.list(dir);
    expect(rows.length).toBe(2);
    expect(findSession(rows, before).id).toBe(before);
    expect(rows.find((row) => row.id !== before)?.cwd).toBe(dir);
    // The cleared screen shows neither the old id nor a leftover prompt.
    expect(app.frame()).not.toContain(before.slice(0, 8));
  });

  it('branches the conversation, and the next ask carries what the parent left behind', async () => {
    // What the model is sent is the only window into the history the app keeps.
    // The screen starts without it on purpose: a fork reads the stored
    // transcript, including the turns another run of cake wrote into the parent.
    const asked: string[] = [];
    scene = await cliScenario(echoModel(asked));

    const { app, dir, store, props } = scene;
    const parent = props.session.id;
    store.saveMessages(parent, parentTranscript);

    await app.submit('/fork');
    await app.waitFor('forked →');
    const copy = store.list(dir).find((row) => row.parentId === parent);
    if (!copy) throw new Error('no session row names the first as its parent');
    // The transcript moved with the branch, and the parent kept its own copy.
    expect(store.messages(copy.id).map((message) => message.role)).toEqual(['user', 'assistant']);

    await app.submit('the second ask');
    await app.waitFor('tokens ·');
    const last = asked.at(-1) ?? '';
    expect(last).toContain('the first ask');
    expect(last).toContain('the second ask');
    expect(store.messages(parent).length).toBe(2);
  });

  it('writes the transcript to the folder it names', async () => {
    const { app, dir } = await mount();

    const target = path.join(dir, 'notes.md');
    await app.submit(`/export ${target}`);
    await app.waitFor('transcript →');
    expect(app.frame()).toContain('notes.md');
    const markdown = await readFile(target, 'utf8');
    // What the frame named is the file, and it is this session's own transcript.
    expect(markdown).toContain(`- workspace \`${dir}\``);
    expect(markdown).toContain('anthropic/claude-sonnet-4-5');
  });

  it('says where a transcript went without pretending there were pictures', async () => {
    const { app } = await mount();
    await app.submit('/export');
    await app.waitFor('.cake');
    expect(app.frame()).not.toContain('picture');
  });

  it('totals a session that has billed nothing', async () => {
    const { app, props } = await mount();
    await app.submit('/cost');
    await app.waitFor('no per-turn detail saved');
    expect(app.frame()).toContain(props.session.id.slice(0, 8));
  });

  it('says what /revert cannot see before there is anything to undo', async () => {
    const { app } = await mount();
    await app.submit('/revert list');
    await app.waitFor('no turn has changed a file cake can undo yet');
    await app.waitFor('not in this undo');
  });

  it('refuses an argument that is not a turn number', async () => {
    const { app } = await mount();
    await app.submit('/revert last one');
    await app.waitFor('/revert takes a turn number');
  });

  it('quits when told to', async () => {
    const { app } = await mount();
    let exited = false;
    void app.waitUntilExit().then(() => {
      exited = true;
    });
    await app.submit('/exit');
    await settle();
    expect(exited).toBe(true);
  });
});
