import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test.setTimeout(240_000);

test('forking keeps the conversation on screen and export writes it to disk', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-fork-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-fork-data-'));
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

    await window.getByTestId('composer-input').fill('create hello.txt');
    await window.getByTestId('composer-send').click();
    await expect(window.getByTestId('approval-card')).toBeVisible();
    await window.getByTestId('approval-allow').click();
    await expect(window.getByTestId('bubble-assistant').last()).toContainText(
      'Created hello.txt.',
      {
        timeout: 30_000,
      },
    );

    // One session, one row of actions.
    const forks = window.getByLabel('Fork session');
    await expect(forks).toHaveCount(1);

    await forks.first().click();

    // The branch is a second row, and it is the one now open.
    await expect(forks).toHaveCount(2, { timeout: 30_000 });
    await expect(window.locator('.session-row.is-active')).toHaveCount(1);

    // The copied transcript is on screen: the tool run and the answer both came
    // through the IPC payload, not from the parent still being in memory.
    await expect(window.getByTestId('tool-card').first()).toContainText('write');
    await expect(window.locator('.turn-prompt').first()).toContainText('create hello.txt');

    await window.locator('.session-row.is-active').getByLabel('Export session as Markdown').click();

    const note = window.getByTestId('entry-note').filter({ hasText: 'transcript →' });
    await expect(note.first()).toBeVisible({ timeout: 30_000 });

    const dir = path.join(workspace, '.cake', 'exports');
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name.endsWith('.md')).toBe(true);

    const markdown = await readFile(path.join(dir, name), 'utf8');
    expect(markdown).toContain('## 1. create hello.txt');
    expect(markdown).toContain('**call `write`**');
    expect(markdown).toContain('hello from e2e');
    expect(markdown).toContain('**result `write`**');
    // The branch knows where it came from, and the id in the header is the open session's.
    expect(markdown).toContain('forked from `');
    const headerId = markdown.match(/session `([0-9a-f]{8})`/)?.[1] ?? 'missing-session-id';
    expect(name).toContain(headerId);
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
