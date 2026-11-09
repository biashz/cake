import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test.setTimeout(240_000);

const UNDO_NOTE = 'Changes a shell command or an MCP tool made are not in this undo.';

test('a finished turn gives its files back, and refuses when a later turn overwrote them', async () => {
  // The second turn rewrites the same file, so undoing the first would throw away
  // the second's work — the case rewind has to stop and ask about.
  const mock = await startMockAnthropic({
    writes: (prompt) =>
      prompt.includes('again') ? { path: 'hello.txt', content: 'hello again\n' } : null,
  });
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-undo-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-undo-data-'));
  await writeFile(
    path.join(userData, 'state.json'),
    JSON.stringify({ lastWorkspace: workspace }),
    'utf8',
  );

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      CAKE_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: mock.url,
      CAKE_USER_DATA: userData,
    },
  });

  const file = path.join(workspace, 'hello.txt');

  /** Type one ask and let the write through, until the answer closes the turn. */
  const ask = async (window: Awaited<ReturnType<typeof app.firstWindow>>, text: string) => {
    await window.getByTestId('composer-input').fill(text);
    await window.getByTestId('composer-send').click();
    await expect(window.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 });
    await window.getByTestId('approval-allow').click();
    await expect(window.getByTestId('bubble-assistant').last()).toContainText('Created', {
      timeout: 30_000,
    });
  };

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

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
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
