import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type Page, test } from '@playwright/test';
import type { MockAnthropic } from './mock-anthropic';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');
const echoServer = path.join(root, 'test', 'fixtures', 'mcp-echo-server.mjs');

test.setTimeout(240_000);

/**
 * Runs one scripted turn and reports how many tools the model was offered.
 * The mock only asks for a `write` on a history with no tool result, so the first
 * turn needs an approval and every later turn answers straight away.
 */
async function toolsSeen(
  window: Page,
  mock: MockAnthropic,
  prompt: string,
  opts: { approval: boolean },
): Promise<number> {
  const before = mock.requests.length;
  const bubbles = await window.getByTestId('bubble-assistant').count();
  await window.getByTestId('composer-input').fill(prompt);
  await window.getByTestId('composer-send').click();

  if (opts.approval) {
    await expect(window.getByTestId('approval-card')).toBeVisible();
    await window.getByTestId('approval-allow').click();
  }

  await expect(window.getByTestId('bubble-assistant')).toHaveCount(bubbles + 1);
  await expect(window.getByTestId('bubble-assistant').last()).toContainText('Created hello.txt.');
  return Math.max(...mock.requests.slice(before).map((request) => request.toolCount));
}

test('MCP manager: add, switch off, edit, fail loudly, remove', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-mcp-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-mcp-data-'));
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

    // A missing tab means the inspector is collapsed; restore it, never close it.
    if ((await window.getByRole('tab', { name: 'Context' }).count()) === 0) {
      await window.getByRole('button', { name: 'Show inspector', exact: true }).click();
    }
    await window.getByRole('tab', { name: 'Context' }).click();

    const section = window.getByTestId('mcp-section');
    await expect(section.getByText('No servers yet.')).toBeVisible();

    const base = await toolsSeen(window, mock, 'first', { approval: true });

    await section.getByRole('textbox', { name: 'Name' }).fill('echo');
    await section.getByRole('textbox', { name: 'Command' }).fill(process.execPath);
    await section.getByRole('textbox', { name: 'Arguments' }).fill(echoServer);
    await expect(
      section.getByText(`Starts ${process.execPath} ${echoServer} and reads its tools over stdio.`),
    ).toBeVisible();
    await section.getByRole('button', { name: 'Add server' }).click();

    await expect(section.getByTestId('mcp-row-echo')).toContainText('2 tools', {
      timeout: 40_000,
    });
    await expect(section.getByTestId('mcp-changes')).toContainText(
      'echo added — online with 2 tools',
    );

    interface Entry {
      command?: string;
      args?: string[];
      url?: string;
      enabled?: boolean;
    }
    const config = async (): Promise<Record<string, Entry>> => {
      const raw = JSON.parse(await readFile(path.join(workspace, '.cake', 'mcp.json'), 'utf8')) as {
        mcpServers?: Record<string, Entry>;
      };
      return raw.mcpServers ?? {};
    };
    expect(Object.keys(await config())).toEqual(['echo']);
    expect(await config()).toMatchObject({
      echo: { command: process.execPath, args: [echoServer], enabled: true },
    });

    // The server the model sees, not just the row in the panel.
    expect(await toolsSeen(window, mock, 'second', { approval: false })).toBe(base + 2);

    await section.getByRole('button', { name: 'Switch off echo' }).click();
    await expect(section.getByTestId('mcp-row-echo')).toContainText('off');
    expect((await config()).echo?.enabled).toBe(false);
    expect(await toolsSeen(window, mock, 'third', { approval: false })).toBe(base);

    await section.getByRole('button', { name: 'Edit echo' }).click();
    await expect(section.getByRole('textbox', { name: 'Name' })).toHaveValue('echo');
    await expect(section.getByRole('textbox', { name: 'Arguments' })).toHaveValue(echoServer);
    await section.getByRole('button', { name: 'Save server' }).click();
    await expect(section.getByTestId('mcp-row-echo')).toContainText('2 tools', {
      timeout: 40_000,
    });
    expect((await config()).echo?.enabled).toBe(true);

    await section.getByRole('textbox', { name: 'Name' }).fill('broken');
    await section
      .getByRole('textbox', { name: 'Command' })
      .fill(path.join(root, 'definitely-not-a-binary'));
    await section.getByRole('button', { name: 'Add server' }).click();
    await expect(section.getByTestId('mcp-row-broken')).toContainText('failed', {
      timeout: 40_000,
    });
    await expect(section.getByTestId('mcp-row-broken')).toContainText('unavailable');
    await expect(window.getByTestId('mcp-line')).toContainText('broken failed');
    expect(await toolsSeen(window, mock, 'fourth', { approval: false })).toBe(base + 2);

    await section.getByRole('button', { name: 'Remove broken' }).click();
    await expect(section.getByTestId('mcp-row-broken')).toHaveCount(0);
    expect(Object.keys(await config())).toEqual(['echo']);

    await section.getByRole('button', { name: 'Reload' }).click();
    await expect(section.getByTestId('mcp-row-echo')).toContainText('2 tools', {
      timeout: 40_000,
    });
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
