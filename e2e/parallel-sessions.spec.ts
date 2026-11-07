import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

/** Each prompt gets its own answer, so a reply can only be proved to be in the right place. */
const ANSWERS: Record<string, string> = {
  'first thread question': 'answer to the first thread',
  'second thread question': 'answer to the second thread',
};

test('two sessions answer at once, each into its own transcript', async () => {
  // The mock withholds both answers until two requests are open at the same
  // time, so a cake that ran one turn at a time would sit here forever.
  const mock = await startMockAnthropic({
    plainText: (prompt) => {
      const key = Object.keys(ANSWERS).find((asked) => prompt.includes(asked));
      return key ? (ANSWERS[key] ?? null) : null;
    },
    holdUntil: 2,
  });
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-e2e-par-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-e2e-par-data-'));
  await writeFile(path.join(userData, 'state.json'), JSON.stringify({ lastWorkspace: workspace }));

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

  try {
    const window = await app.firstWindow();
    const input = window.getByTestId('composer-input');
    await expect(input).toBeVisible({ timeout: 30_000 });

    const row = (title: string) => window.locator('.session-main', { hasText: title });

    await input.fill('first thread question');
    await window.getByTestId('composer-send').click();
    await expect.poll(() => mock.requests.length).toBe(1);

    // Held open by the mock: the question is on the wire, the answer is nowhere.
    await expect(window.getByTestId('transcript')).not.toContainText('answer to the first thread');
    // The rail already knows which session is asking, before any answer lands.
    await expect(row('first thread question')).toBeVisible();

    // A second conversation starts while the first is still waiting.
    await window.getByRole('button', { name: /New session/ }).click();
    await expect(window.getByTestId('rail-badge-running')).toHaveText('answering');
    await expect(window.getByTestId('rail-live')).toHaveText('1 answering');

    await input.fill('second thread question');
    await window.getByTestId('composer-send').click();

    // Two requests open at the same time is what releases both answers, so the
    // second turn starting is proof the first one never held the app.
    await expect.poll(() => mock.requests.length).toBe(2);

    // The gate is met, so both answers arrive; each belongs to its own session.
    await expect(window.getByTestId('bubble-assistant').last()).toContainText(
      'answer to the second thread',
      { timeout: 30_000 },
    );
    await expect(window.getByTestId('rail-live')).toHaveCount(0);
    await expect(window.getByTestId('rail-badge-running')).toHaveCount(0);

    // The first answer landed while you were reading another conversation, and
    // the app said so where a screen reader would hear it.
    await expect(window.getByTestId('rail-announce')).toContainText(
      /first thread question.*has an answer/,
    );

    await row('first thread question').click();
    await expect(window.getByTestId('bubble-assistant').last()).toContainText(
      'answer to the first thread',
    );
    await expect(window.getByTestId('transcript')).not.toContainText('answer to the second thread');

    await row('second thread question').click();
    await expect(window.getByTestId('bubble-assistant').last()).toContainText(
      'answer to the second thread',
    );
    await expect(window.getByTestId('transcript')).not.toContainText('answer to the first thread');
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
