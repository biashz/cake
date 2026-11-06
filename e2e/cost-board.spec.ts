import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test.setTimeout(240_000);

/**
 * One scripted turn. The mock streams a `write` call only while the history holds no
 * tool result, so the first turn needs an approval and every later turn answers directly.
 */
async function runTurn(window: Page, prompt: string, opts: { approval: boolean }): Promise<void> {
  const bubbles = await window.getByTestId('bubble-assistant').count();
  await window.getByTestId('composer-input').fill(prompt);
  await window.getByTestId('composer-send').click();

  if (opts.approval) {
    await expect(window.getByTestId('approval-card')).toBeVisible();
    await window.getByTestId('approval-allow').click();
  }

  await expect(window.getByTestId('bubble-assistant')).toHaveCount(bubbles + 1);
  await expect(window.getByTestId('bubble-assistant').last()).toContainText('Created hello.txt.');
}

/** Points the next turn at a model cake has no rate for. */
async function pickModel(window: Page, modelId: string): Promise<void> {
  await window.getByTitle('Switch provider and model').click();
  await window.getByLabel('Model id').fill(modelId);
  await window.getByRole('button', { name: 'Use model' }).click();
  await expect(window.getByTitle('Switch provider and model')).toContainText(modelId);
}

test('cost board: per-turn rows, an unpriced model, workspace totals', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-cost-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-cost-data-'));
  // Pre-seed the last workspace so the window opens it without a native dialog.
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

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    if ((await window.getByRole('tab', { name: 'Cost' }).count()) === 0) {
      await window.getByRole('button', { name: 'Toggle inspector' }).click();
    }
    await window.getByRole('tab', { name: 'Cost' }).click();

    const panel = window.getByTestId('cost-panel');
    const turns = window.getByTestId('cost-turn-row');
    const totals = window.getByTestId('cost-workspace');

    await expect(panel.getByText('Nothing billed yet in this session.')).toBeVisible();

    // One turn is one row, and the row says which model that turn paid for.
    await runTurn(window, 'first', { approval: true });
    await expect(turns).toHaveCount(1);
    await expect(totals.locator('dd').first()).toHaveText('1');
    // Every billed turn kept rows, so nothing has to be explained as a gap.
    await expect(window.getByTestId('cost-detail-note')).toHaveCount(0);
    await turns.locator('summary').click();
    const line = window.getByTestId('cost-line');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText('Main model');
    await expect(line).toContainText('anthropic/');

    await runTurn(window, 'second', { approval: false });
    await expect(turns).toHaveCount(2);
    await expect(turns.first().locator('summary')).toContainText('2');

    // A model with no rate: its tokens are counted, its spend is never read as free.
    await pickModel(window, 'claude-mystery-1');
    await runTurn(window, 'third', { approval: false });
    await expect(turns).toHaveCount(3);
    await expect(turns.first().locator('summary')).toContainText('no price set');
    await expect(window.getByTestId('cost-spend')).toContainText('+ unpriced');
    await expect(panel.getByText(/No price set for this model/)).toBeVisible();
    await expect(panel.locator('.is-unpriced')).toHaveCount(1);
    // The known-rate turns keep their estimate; one unknown model does not zero them.
    await expect(turns.nth(1).locator('summary')).not.toContainText('no price set');

    // Only the unpriced model group offers a rate, and it offers the right pattern.
    const setRate = panel.getByRole('button', { name: 'Set rate' });
    await expect(setRate).toHaveCount(1);
    await setRate.click();
    await expect(panel.getByRole('textbox', { name: 'Pattern' })).toHaveValue(
      'anthropic/claude-mystery-1',
    );

    // A second session in the same folder: its own board is empty, the totals are not.
    await window.getByRole('button', { name: /New session/ }).click();
    await expect(panel.getByText('Nothing billed yet in this session.')).toBeVisible();
    await expect(turns).toHaveCount(0);
    await expect(totals.locator('dd').first()).toHaveText('2');
    await expect(totals.locator('dd').nth(1)).toContainText('+ unpriced');
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
