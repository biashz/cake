import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { type MockAnthropicOptions, startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test.setTimeout(240_000);

const UNDO_NOTE = 'Changes a shell command or an MCP tool made are not in this undo.';

/** The app on a scratch workspace, with the files the spec needs already in it. */
async function startApp(options: MockAnthropicOptions, seed: Record<string, string> = {}) {
  const mock = await startMockAnthropic(options);
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-undo-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-undo-data-'));
  for (const [rel, content] of Object.entries(seed)) {
    await writeFile(path.join(workspace, rel), content, 'utf8');
  }
  await writeFile(
    path.join(userData, 'state.json'),
    JSON.stringify({ lastWorkspace: workspace }),
    'utf8',
  );

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      // Pin the provider so a developer's real key cannot bypass the mock.
      CAKE_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: mock.url,
      CAKE_USER_DATA: userData,
    },
  });
  const window = await app.firstWindow();
  await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

  return {
    window,
    workspace,
    async close() {
      await app.close();
      await mock.close();
      await rm(workspace, { recursive: true, force: true });
      await rm(userData, { recursive: true, force: true });
    },
  };
}

/** Type one ask and let the write through, up to whatever ends the turn. */
async function submit(window: Page, text: string) {
  await window.getByTestId('composer-input').fill(text);
  await window.getByTestId('composer-send').click();
  await expect(window.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 });
  await window.getByTestId('approval-allow').click();
}

/** ... and the answer that closes it, when the provider gets that far. */
async function ask(window: Page, text: string) {
  await submit(window, text);
  await expect(window.getByTestId('bubble-assistant').last()).toContainText('Created', {
    timeout: 30_000,
  });
}

test('a finished turn gives its files back, and refuses when a later turn overwrote them', async () => {
  // The second turn rewrites the same file, so undoing the first would throw away
  // the second's work — the case rewind has to stop and ask about.
  const ui = await startApp({
    writes: (prompt) =>
      prompt.includes('again') ? { path: 'hello.txt', content: 'hello again\n' } : null,
  });
  const { window } = ui;
  const file = path.join(ui.workspace, 'hello.txt');

  try {
    await ask(window, 'create hello.txt');
    expect(await readFile(file, 'utf8')).toBe('hello from e2e\n');

    // The card that made the file offers to give it back, and says which file
    // before it moves anything.
    const first = window.getByTestId('turn-undo').first();
    await expect(first).toBeVisible();
    await expect(first).toContainText('hello.txt goes back');
    await expect(first).toContainText(UNDO_NOTE);
    await expect(window.locator('.turn-undone-tag')).toHaveCount(1);

    // A second turn over the same file, so there is later work to lose.
    await ask(window, 'again, create hello.txt');
    expect(await readFile(file, 'utf8')).toBe('hello again\n');
    await expect(window.getByTestId('turn-undo')).toHaveCount(2);

    // Leaving the session and coming back rebuilds the cards from stored turns,
    // so the undo on offer after the round trip is proof the archive is found by
    // what the turn asked for rather than by anything kept in memory.
    await window.getByRole('button', { name: /New session/ }).click();
    await expect(window.getByTestId('turn-undo')).toHaveCount(0);
    await window.locator('.session-main', { hasText: 'create hello.txt' }).click();
    await expect(window.getByTestId('turn-undo')).toHaveCount(2);

    // Undoing the first turn now refuses: the later one changed the same file.
    await window.getByTestId('turn-undo-button').first().click();
    const blocked = window.getByTestId('turn-undo-blocked');
    await expect(blocked).toContainText('Nothing moved');
    await expect(blocked).toContainText('again, create hello.txt');
    expect(await readFile(file, 'utf8')).toBe('hello again\n');

    // Confirmed, it goes through — and the file the first turn created is gone.
    await expect(window.getByTestId('turn-undo-button').first()).toHaveText('Undo anyway');
    await window.getByTestId('turn-undo-button').first().click();
    const list = window.getByTestId('turn-undo-list');
    await expect(list).toContainText('hello.txt');
    await expect(list).toContainText('removed (the turn created it)');
    expect(existsSync(file)).toBe(false);
  } finally {
    await ui.close();
  }
});

test('the turn a provider refuses still gives the file it changed back', async () => {
  // The write happens, then the request that would report it is refused. That turn
  // bills nothing and stores no transcript, so nothing but the words it asked can
  // connect its card to the archive it closed — and a refusal has to land on the
  // request after its own tool call, never on a later turn.
  const ui = await startApp(
    {
      writes: (prompt) =>
        prompt.includes('refuse')
          ? { path: 'hello.txt', content: 'written before the refusal\n' }
          : null,
      fails: (prompt) => prompt.includes('refuse'),
    },
    { 'hello.txt': 'before\n' },
  );

  try {
    const { window } = ui;
    const file = path.join(ui.workspace, 'hello.txt');

    await submit(window, 'refuse, create hello.txt');
    // The refusal arrives twice over — once on the turn's own channel, once as the
    // rejected IPC call — so the last entry is where the transcript ends.
    await expect(window.getByTestId('entry-error').last()).toBeVisible({ timeout: 30_000 });
    expect(await readFile(file, 'utf8')).toBe('written before the refusal\n');

    // The turn ended in an error and left no answer behind, yet the card that asked
    // still names the file it changed.
    await expect(window.getByTestId('turn-undo')).toContainText('hello.txt goes back');

    // And the way back works: the archive holds the bytes from before the write.
    await window.getByTestId('turn-undo-button').click();
    await expect(window.getByTestId('turn-undo-list')).toContainText('hello.txt put back');
    expect(await readFile(file, 'utf8')).toBe('before\n');

    // A later turn is nobody's held refusal: the answer the broken turn never
    // gave must not be delivered against the next one's tool call.
    await ask(window, 'now write it properly');
    expect(await readFile(file, 'utf8')).toBe('hello from e2e\n');
  } finally {
    await ui.close();
  }
});
