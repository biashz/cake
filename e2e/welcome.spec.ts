import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

/**
 * The first window a new user sees has no folder yet, and the kernel answers
 * session:list with an error in exactly that state. Asking anyway used to put
 * Electron's own wrapper sentence on the welcome screen.
 */
test('a first run opens the welcome screen with nothing to dismiss', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-welcome-data-'));
  // No state.json: there is no last workspace, so nothing is opened for you.

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      CAKE_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4597',
      CAKE_USER_DATA: userData,
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator('.welcome')).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    // The one sentence that must not be here is the one that used to be.
    await expect(window.locator('[role="alert"]')).toHaveCount(0);
    await expect(window.locator('.error-banner')).toHaveCount(0);
    // And no session rail noise either: there is no session to list.
    await expect(window.locator('.session-row')).toHaveCount(0);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
