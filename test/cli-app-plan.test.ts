import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliScenario, cliScenario, scriptedTurn } from './support/cli-app.js';

/**
 * The plan box: the checklist the model keeps while it works, drawn from the
 * same task list the desktop shows as a panel. It is the only place the CLI
 * answers "how far along is this", so the marks and the count have to agree
 * with the list underneath them.
 */

let scene: CliScenario | null = null;

afterEach(async () => {
  scene?.close();
  if (scene) await rm(scene.dir, { recursive: true, force: true });
  scene = null;
});

/** Two steps, one finished, one started, then the model stops talking. */
const planned = [
  { tool: { name: 'task', input: { action: 'add', subject: 'step one' } } },
  { tool: { name: 'task', input: { action: 'add', subject: 'step two' } } },
  { tool: { name: 'task', input: { action: 'update', id: 1, status: 'completed' } } },
  { tool: { name: 'task', input: { action: 'update', id: 2, status: 'in_progress' } } },
  { text: 'one down' },
];

async function planOnScreen(): Promise<CliScenario> {
  const scene2 = await cliScenario(scriptedTurn(planned), { mode: 'yolo' });
  await scene2.app.submit('work through the plan');
  await scene2.app.ready();
  return scene2;
}

/**
 * The box's own rows, and nothing else. A `task` call leaves its list on the
 * transcript too — `← task [x] 1. step one` quotes the very same text — so an
 * assertion against the whole screen can be satisfied by the line that reports
 * the ask rather than the box that answers "how far along is this".
 */
function box(frame: string): string {
  return frame
    .split('\n')
    .filter((line) => line.trimStart().startsWith('│'))
    .join('\n');
}

describe('what the plan box says', () => {
  it('stays off the screen while there is nothing planned', async () => {
    scene = await cliScenario(scriptedTurn([{ text: 'nothing to list' }]));
    await scene.app.submit('just answer');
    await scene.app.ready();
    expect(scene.app.frame()).not.toContain('plan ·');
  });

  it('marks each step with the state the model left it in', async () => {
    scene = await planOnScreen();
    expect(box(scene.app.frame())).toContain('[x] 1. step one');
    expect(box(scene.app.frame())).toContain('[~] 2. step two');
  });

  it('counts finished steps, not started ones', async () => {
    // Two finished and one half-done: a counter that also counts the started
    // step reads 1/3, one that counts anything not pending reads 3/3.
    scene = await cliScenario(
      scriptedTurn([
        { tool: { name: 'task', input: { action: 'add', subject: 'step one' } } },
        { tool: { name: 'task', input: { action: 'add', subject: 'step two' } } },
        { tool: { name: 'task', input: { action: 'add', subject: 'step three' } } },
        { tool: { name: 'task', input: { action: 'update', id: 1, status: 'completed' } } },
        { tool: { name: 'task', input: { action: 'update', id: 2, status: 'completed' } } },
        { tool: { name: 'task', input: { action: 'update', id: 3, status: 'in_progress' } } },
        { text: 'two down' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('work through the plan');
    await scene.app.ready();
    expect(box(scene.app.frame())).toContain('plan · 2/3 done');
  });

  it('shows a step nobody has started as not started', async () => {
    scene = await cliScenario(
      scriptedTurn([
        { tool: { name: 'task', input: { action: 'add', subject: 'later' } } },
        { text: 'listed' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('plan it out');
    await scene.app.ready();
    expect(box(scene.app.frame())).toContain('[ ] 1. later');
    expect(box(scene.app.frame())).toContain('plan · 0/1 done');
  });

  it('clears the box with the session it belonged to', async () => {
    scene = await planOnScreen();
    expect(box(scene.app.frame())).toContain('plan · 1/2 done');
    await scene.app.submit('/clear');
    await scene.app.waitFor('new session');
    expect(scene.app.frame()).not.toContain('plan ·');
  });

  it('carries the plan into the session /fork starts', async () => {
    scene = await planOnScreen();
    await scene.app.submit('/fork');
    await scene.app.waitFor('forked →');
    expect(box(scene.app.frame())).toContain('plan · 1/2 done');
    expect(box(scene.app.frame())).toContain('[x] 1. step one');
  });

  it('keeps the list after the turn that made it', async () => {
    scene = await planOnScreen();
    // A turn that plans nothing of its own must not empty the box.
    await scene.app.submit('and now?');
    await scene.app.ready();
    expect(box(scene.app.frame())).toContain('plan · 1/2 done');
  });

  it('lets a later turn add to the list the first one made', async () => {
    scene = await cliScenario(
      scriptedTurn([
        ...planned,
        { tool: { name: 'task', input: { action: 'add', subject: 'step three' } } },
        { text: 'one more' },
      ]),
      { mode: 'yolo' },
    );
    await scene.app.submit('work through the plan');
    await scene.app.ready();
    await scene.app.submit('and a third step');
    await scene.app.ready();
    expect(box(scene.app.frame())).toContain('[ ] 3. step three');
    expect(box(scene.app.frame())).toContain('plan · 1/3 done');
  });
});
