import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test.setTimeout(240_000);

test('a @codebase turn shows the chunks it read and quotes one back', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-hits-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-hits-data-'));
  await writeFile(
    path.join(workspace, 'alpha.ts'),
    'export function alphaHandler() {\n  return "alpha";\n}\n',
    'utf8',
  );
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
      // The same mock answers /v1/embeddings, so semantic search runs offline.
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: `${mock.url}/v1`,
      CAKE_USER_DATA: userData,
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    await window.getByTestId('composer-input').fill('what does @codebase alphaHandler return?');
    await window.getByTestId('composer-send').click();

    // The mock opens with a write call on the first turn, so approve it to finish.
    await expect(window.getByTestId('approval-card')).toBeVisible();
    await window.getByTestId('approval-allow').click();

    const note = window.getByTestId('entry-note');
    await expect(note.filter({ hasText: 'codebase' }).first()).toBeVisible({ timeout: 60_000 });

    const cards = window.getByTestId('codebase-hit');
    await expect(cards.first()).toBeVisible();
    await expect(cards.first()).toContainText('alpha.ts');
    await expect(cards.first()).toContainText('1–3');

    // A card is a handle: the file it names lands in the composer for the next ask.
    await cards.first().click();
    await expect(window.getByTestId('composer-input')).toHaveValue(/@alpha\.ts/);
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
