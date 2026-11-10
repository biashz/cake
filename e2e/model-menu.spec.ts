import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

/**
 * The footnote of the model menu, in the built bundle. A unit test can prove the
 * string is computed from the id in the box; only Electron says the popover the
 * person opens shows the numbers for that id rather than for some other model.
 */
async function hintFor(window: Page, modelId: string): Promise<string> {
  await window.getByLabel('Model id').fill(modelId);
  const hint = window.getByTestId('model-hint');
  await expect(hint).toBeVisible();
  return (await hint.textContent()) ?? '';
}

test('the model menu states the id in the box, and admits a guess', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-menu-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-menu-data-'));
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

    await window.getByTitle('Switch provider and model').click();
    await expect(window.getByRole('dialog', { name: 'Choose model' })).toBeVisible();

    const wide = (200_000).toLocaleString();

    // Opening the menu already names a model, and that one has a row.
    await expect(window.getByTestId('model-hint')).toHaveText(
      `context ${wide} · images ok · key ready`,
    );

    // A row that denies vision, so the footnote is not one fixed sentence.
    const haiku = await hintFor(window, 'claude-3-haiku-20240307');
    expect(haiku).toContain('no images');
    expect(haiku).not.toContain('assumed');

    // An id with no row: the window it quotes is the baseline, and it says so.
    const guessing = await hintFor(window, 'claude-nova-9');
    expect(guessing).toBe(`context ${wide} (assumed) · images ok · key ready`);

    // An empty box names no model, so it states no numbers about one.
    expect(await hintFor(window, '   ')).toBe('key ready');

    // What the footnote promised is what the chip keeps after applying it.
    await window.getByLabel('Model id').fill('claude-3-haiku-20240307');
    await window.getByRole('button', { name: 'Use model' }).click();
    await expect(window.getByTitle('Switch provider and model')).toContainText(
      'claude-3-haiku-20240307',
    );
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
