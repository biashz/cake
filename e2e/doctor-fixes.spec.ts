import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

test.setTimeout(180_000);

/** One diagnostics row: its status dot and the action that clears the warning. */
function row(window: Page, label: string) {
  return window
    .locator('.doctor-row')
    .filter({ has: window.locator(`.doctor-label >> text="${label}"`) });
}

test('doctor: a warning offers the fix, and the fix really lands', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-doctor-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-doctor-data-'));
  // A stored key is written to the home config, so the run needs a home of its own.
  const home = await mkdtemp(path.join(tmpdir(), 'cake-doctor-home-'));
  await writeFile(
    path.join(userData, 'state.json'),
    JSON.stringify({ lastWorkspace: workspace }),
    'utf8',
  );

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) {
    delete env[name];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.CAKE_USER_DATA = userData;

  const app = await electron.launch({ args: [mainEntry], env });

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    const notice = window.getByText(/No API key for/);
    await expect(notice).toContainText('openai');

    if ((await window.getByRole('tab', { name: 'Context' }).count()) === 0) {
      await window.getByRole('button', { name: 'Toggle inspector' }).click();
    }
    await window.getByRole('tab', { name: 'Context' }).click();
    await window.getByRole('button', { name: 'Run checks' }).click();
    await expect(window.getByText(/checks? you can fix/)).toBeVisible();

    const semantic = row(window, 'semantic search');
    await expect(semantic.locator('.status-dot')).toHaveClass(/is-warn/);
    const save = semantic.getByRole('button', { name: 'Save key' });
    await expect(save).toBeDisabled();

    // Nothing can build an index until the key exists, so the row says so.
    const index = row(window, 'code index');
    await expect(index.getByRole('button', { name: 'Rebuild index' })).toHaveCount(0);

    await semantic.getByLabel('openai API key').fill('sk-e2e-not-a-real-key');
    await expect(save).toBeEnabled();
    await save.click();

    // A key that only reached the file would leave the index row still asking for one.
    await expect(semantic.locator('.status-dot')).toHaveClass(/is-ok/);
    await expect(index.getByRole('button', { name: 'Rebuild index' })).toBeVisible();
    await expect(notice).not.toContainText('openai');

    const stored = JSON.parse(await readFile(path.join(home, '.cake', 'config.json'), 'utf8')) as {
      providers?: { openai?: { apiKey?: string } };
    };
    expect(stored.providers?.openai?.apiKey).toBe('sk-e2e-not-a-real-key');

    // Reconnecting is offered even while the servers read as healthy.
    await expect(
      row(window, 'MCP servers').getByRole('button', { name: /Open MCP config|Reconnect/ }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
