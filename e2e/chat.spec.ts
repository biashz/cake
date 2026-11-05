import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test('chat turn: write tool -> approval -> file on disk -> answer', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-e2e-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-e2e-data-'));
  // Pre-seed the last workspace so the window opens it without a native dialog.
  await writeFile(path.join(userData, 'state.json'), JSON.stringify({ lastWorkspace: workspace }));
  await writeFile(path.join(workspace, 'notes.md'), '# sample\n');

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      // Pin the provider so a developer's real DeepSeek key cannot bypass the mock.
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

    await input.fill('create hello.txt');
    await window.getByTestId('composer-send').click();

    const approval = window.getByTestId('approval-card');
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText('write');
    await window.getByTestId('approval-allow').click();

    await expect(window.getByTestId('tool-card')).toContainText('done', { timeout: 30_000 });
    await expect(window.getByTestId('bubble-assistant').last()).toContainText(
      'Created hello.txt.',
      { timeout: 30_000 },
    );

    expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe('hello from e2e\n');
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    expect(mock.requests.some((request) => request.hasToolResult)).toBe(true);
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
