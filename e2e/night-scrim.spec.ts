import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

/**
 * The night theme used to declare `--scrim: var(--scrim)`. A custom property that
 * names itself is invalid at computed-value time, so it holds no value at all and
 * the overlay's `background: var(--scrim)` fell back to transparent — the palette
 * floated over an undimmed page. Only the CSS engine settles that argument, so it
 * is measured here rather than reasoned about.
 */
test('the command palette dims the page behind it in both themes', async () => {
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-scrim-data-'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-scrim-ws-'));
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
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4599',
      CAKE_USER_DATA: userData,
    },
  });

  try {
    const window = await app.firstWindow();
    // Boot in the night theme through the app's own preference, so the rule that
    // gets measured is the one the theme switcher would have selected.
    await window.addInitScript(() => {
      window.localStorage.setItem('cake.ui.v2', JSON.stringify({ theme: 'cocoa' }));
    });
    await window.reload();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => window.evaluate(() => document.documentElement.dataset.theme))
      .toBe('cocoa');

    const read = async () => {
      await window.keyboard.press('Control+k');
      const overlay = window.locator('.palette-overlay');
      await expect(overlay).toBeVisible({ timeout: 10_000 });
      const painted = await overlay.evaluate((node) => {
        const color = getComputedStyle(node).backgroundColor;
        const numbers = color.match(/[\d.]+/g) ?? [];
        return { color, alpha: numbers.length > 3 ? Number(numbers[3]) : 1 };
      });
      await window.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
      return painted;
    };

    const night = await read();
    expect(night.alpha, `night scrim painted ${night.color}`).toBeGreaterThan(0.2);

    await window.evaluate(() => {
      document.documentElement.dataset.theme = 'flour';
    });
    const day = await read();
    expect(day.alpha).toBeGreaterThan(0.2);
    // Two themes, two scrims: the night one is its own colour, not the day one
    // inherited because nothing overrode it.
    expect(night.color).not.toBe(day.color);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
