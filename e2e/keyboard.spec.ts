import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

/**
 * Where the keyboard actually is. jsdom lets a test assert focus by calling
 * `.focus()` itself; only a browser says where focus landed after the app moved
 * it, which is the whole claim here.
 */
function focusState(window: Page) {
  return window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      insideDialog: Boolean(el?.closest('[role="dialog"]')),
      ariaLabel: el?.getAttribute('aria-label') ?? '',
      title: el?.getAttribute('title') ?? '',
      id: el?.id ?? '',
      testId: el?.getAttribute('data-testid') ?? '',
    };
  });
}

test('the keyboard gets in and out of every popover, tablist, and the palette', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-e2e-keys-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-e2e-keys-data-'));
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

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    const chip = window.getByTitle('Switch provider and model');
    await chip.focus();
    // No mouse: Enter on the focused chip is what opens the menu.
    await window.keyboard.press('Enter');
    await expect.poll(async () => (await focusState(window)).insideDialog).toBe(true);

    // Tab is the key that leaves, so it is the one that must not.
    await window.keyboard.press('Tab');
    await expect.poll(async () => (await focusState(window)).insideDialog).toBe(true);

    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Choose model' })).toHaveCount(0);
    expect((await focusState(window)).title).toBe('Switch provider and model');

    // A missing tab means the inspector is collapsed; restore it, never close it.
    if ((await window.getByRole('tab', { name: 'Cost' }).count()) === 0) {
      await window.getByRole('button', { name: 'Show inspector', exact: true }).click();
    }
    const active = window.getByRole('tab', { selected: true });
    await active.focus();
    await window.keyboard.press('ArrowRight');

    // The selection and the caret move as one, or Tab would jump back to a
    // different tab than the one being read.
    await expect(active).toHaveAttribute('id', 'tab-plan');
    expect((await focusState(window)).id).toBe('tab-plan');
    await window.keyboard.press('End');
    await expect(active).toHaveAttribute('id', 'tab-files');
    expect((await focusState(window)).id).toBe('tab-files');
    await expect(window.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-files');

    // Ctrl K is the one way in, so it cannot be the way the keyboard gets lost.
    const input = window.getByTestId('composer-input');
    await input.focus();
    await window.keyboard.press('Control+k');
    await expect(window.getByLabel('Command palette search')).toBeVisible();
    await expect
      .poll(async () => (await focusState(window)).ariaLabel)
      .toBe('Command palette search');

    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    expect((await focusState(window)).testId).toBe('composer-input');
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
