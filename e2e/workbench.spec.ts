import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
} from '@playwright/test';
import { type MockAnthropic, startMockAnthropic } from './mock-anthropic';

const mainEntry = path.join(process.cwd(), 'dist', 'desktop', 'main.cjs');

interface Workbench {
  app: ElectronApplication;
  window: Page;
  mock: MockAnthropic;
  workspace: string;
}

/** Size the renderer, not the OS frame: 720 means 720 CSS pixels on Windows too. */
async function resize({ app, window }: Workbench, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, contentWidth) => {
    const browser = BrowserWindow.getAllWindows()[0];
    if (!browser) throw new Error('No workbench window');
    browser.setContentSize(contentWidth, 900);
  }, width);
  await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(width);
}

const test = base.extend<{ workbench: Workbench }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring even for a fixture with no dependencies.
  workbench: async ({}, use) => {
    const mock = await startMockAnthropic();
    const workspace = await mkdtemp(path.join(tmpdir(), 'cake-workbench-ws-'));
    const userData = await mkdtemp(path.join(tmpdir(), 'cake-workbench-data-'));
    let app: ElectronApplication | undefined;
    try {
      await writeFile(
        path.join(userData, 'state.json'),
        JSON.stringify({ lastWorkspace: workspace }),
      );
      await writeFile(path.join(workspace, 'notes.md'), '# Workbench fixture\n');
      app = await electron.launch({
        args: [mainEntry],
        env: {
          ...process.env,
          // Never let a developer's other provider/key bypass the local server.
          CAKE_PROVIDER: 'anthropic',
          ANTHROPIC_API_KEY: 'test-key',
          ANTHROPIC_BASE_URL: mock.url,
          CAKE_USER_DATA: userData,
        },
      });
      const window = await app.firstWindow();
      const workbench = { app, window, mock, workspace };
      await resize(workbench, 1360);
      // Use real persisted preferences, rather than changing the DOM's theme by hand.
      await window.evaluate(() => {
        localStorage.setItem(
          'cake.ui.v2',
          JSON.stringify({
            theme: 'flour',
            railOpen: true,
            inspectorOpen: true,
          }),
        );
      });
      await window.reload();
      await expect(window.getByTestId('composer-input')).toBeEnabled({ timeout: 30_000 });
      await expect(
        window.getByRole('complementary', { name: 'Sessions', exact: true }),
      ).toBeVisible();
      await expect(
        window.getByRole('complementary', { name: 'Inspector', exact: true }),
      ).toBeVisible();
      await use(workbench);
    } finally {
      try {
        await app?.close();
      } finally {
        await mock.close();
        await rm(workspace, { recursive: true, force: true });
        await rm(userData, { recursive: true, force: true });
      }
    }
  },
});

const starters = [
  {
    label: 'Explore this project',
    prompt:
      'Explore this project. Explain its architecture, key entry points, and how to run its tests. Do not modify files.',
  },
  {
    label: 'Review code',
    prompt:
      'Review the current code for bugs. Show concrete findings with file references and suggest focused fixes. Do not modify files yet.',
  },
  {
    label: 'Add tests',
    prompt:
      'Help me add tests. First identify important untested behavior and propose test cases before making changes.',
  },
];

test('workbench: starters fill or append a draft without requesting the model', async ({
  workbench,
}) => {
  const { window, mock } = workbench;
  const input = window.getByTestId('composer-input');
  const transcript = window.getByRole('log', { name: 'Conversation' });
  await expect(window.getByTestId('transcript-empty')).toHaveText('No turns yet.');
  await expect(transcript.getByRole('button')).toHaveCount(3);
  await expect(window.getByTestId('composer-send')).toBeDisabled();
  expect(mock.requests).toHaveLength(0);

  for (const { label, prompt } of starters) {
    // Supporting text is part of the accessible name, after the action label.
    const starter = transcript.getByRole('button', { name: new RegExp(`^${label}`) });
    await expect(starter).toBeVisible();
    await expect(starter).toHaveJSProperty('tagName', 'BUTTON');
    await expect(starter).toHaveAttribute('type', 'button');
    await input.fill('');
    await starter.click();
    await expect(input).toHaveValue(prompt);
    await expect(input).toBeFocused();
    await expect(window.getByTestId('composer-send')).toBeEnabled();
    await expect(window.getByTestId('turn')).toHaveCount(0);
    expect(mock.requests, `${label} must not submit`).toHaveLength(0);
    await input.press('Control+Home');
    await input.press('ArrowRight');
    await input.pressSequentially('XY');
    await expect(input).toHaveValue(`${prompt.slice(0, 1)}XY${prompt.slice(1)}`);

    const draft = 'Keep this original draft.\nOnly touch the requested file.';
    await input.fill(draft);
    await starter.click();
    await expect(input).toHaveValue(`${draft}\n\n${prompt}`);
    await expect(input).toBeFocused();
    await expect(window.getByTestId('transcript-empty')).toBeVisible();
    await expect(window.getByTestId('approval-card')).toHaveCount(0);
    await expect(window.getByTestId('composer-stop')).toHaveCount(0);
    expect(mock.requests, `${label} must only append`).toHaveLength(0);
  }
});

test('workbench: composer context actions restore Files and Context without sending', async ({
  workbench,
}) => {
  const { window, mock } = workbench;
  const inspector = window.getByRole('complementary', { name: 'Inspector', exact: true });
  const input = window.getByTestId('composer-input');
  await input.fill('Please inspect');
  await inspector.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await expect(inspector).toHaveCount(0);

  await window.getByRole('button', { name: 'Add context', exact: true }).click();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(inspector.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-files');
  await inspector.getByTitle('Add @notes.md', { exact: true }).click();
  await expect(input).toHaveValue('Please inspect @notes.md ');
  await expect(input).toBeFocused();

  await inspector.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await expect(inspector).toHaveCount(0);
  const usage = window.locator('.composer').getByRole('button', {
    name: /^Context usage \d+%\. Show context details$/,
  });
  await expect(usage).toBeVisible();
  await usage.click();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('tab', { name: 'Context', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(inspector.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-context');
  await expect(input).toHaveValue('Please inspect @notes.md ');
  await expect(window.getByTestId('turn')).toHaveCount(0);
  expect(mock.requests).toHaveLength(0);
});

test('workbench: approval waits visibly and a completed tool keeps its diff collapsed', async ({
  workbench,
}, testInfo) => {
  const { window, mock, workspace } = workbench;
  await window.getByTestId('composer-input').fill('create hello.txt');
  await window.getByTestId('composer-send').click();

  const approval = window.getByTestId('approval-card');
  const tool = window.getByTestId('tool-card');
  const head = tool.locator('.tool-head');
  await expect(approval).toBeVisible();
  await expect(approval).toHaveAttribute('role', 'alert');
  await expect(approval).toContainText('write');
  await expect(approval).toContainText('hello.txt');
  await expect(approval.getByTestId('diff')).toBeVisible();
  await expect(window.locator('.heat-state')).toHaveText('Waiting for approval');
  await expect(window.locator('.heat-state')).not.toHaveText('Working');
  await expect(window.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(window.getByTestId('composer-input')).toBeDisabled();
  await expect(window.getByTestId('composer-send')).toHaveCount(0);
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(head.locator('.diff-count-add')).toHaveText('+2');
  await expect(head.locator('.diff-count-remove')).toHaveText('−0');
  await expect(tool.getByTestId('diff')).toHaveCount(0);
  await expect(tool.locator('.tool-detail')).toHaveCount(0);
  await expect(window.locator('.change-row')).toHaveCount(0);
  await expect(window.getByText('No file changes yet.')).toBeVisible();
  await expect(readFile(path.join(workspace, 'hello.txt'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(mock.requests).toHaveLength(1);
  await window.screenshot({ path: testInfo.outputPath('workbench-approval.png') });

  await approval.getByTestId('approval-allow').click();
  await expect(approval).toHaveCount(0);
  await expect(tool.locator('.tool-state')).toHaveText('done');
  await expect(window.getByTestId('bubble-assistant').last()).toContainText('Created hello.txt.');
  expect(await readFile(path.join(workspace, 'hello.txt'), 'utf8')).toBe('hello from e2e\n');
  expect(mock.requests.some((request) => request.hasToolResult)).toBe(true);
  await expect(window.locator('.heat-state')).toHaveText('Ready');
  await expect(window.locator('.change-row')).toHaveCount(1);
  await expect(window.locator('.change-row')).toContainText('hello.txt');
  await expect(window.getByTestId('composer-stop')).toHaveCount(0);
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(tool.getByTestId('diff')).toHaveCount(0);

  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(tool.getByTestId('diff')).toBeVisible();
  await expect(tool.locator('.diff-add').first()).toContainText('hello from e2e');
  await expect(tool.locator('.detail-label')).toHaveText(['input', 'result']);
  expect(
    JSON.parse((await tool.locator('.tool-detail > pre').first().textContent()) ?? ''),
  ).toEqual({
    path: 'hello.txt',
    content: 'hello from e2e\n',
  });
  await expect(tool.locator('.tool-detail > pre').last()).toHaveText(
    'Wrote 15 bytes (1 line) to hello.txt',
  );
  await window.screenshot({ path: testInfo.outputPath('workbench-tool-expanded.png') });
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(tool.locator('.tool-detail')).toHaveCount(0);
  await expect(head.locator('.diff-count-add')).toHaveText('+2');
  await expect(head.locator('.diff-count-remove')).toHaveText('−0');
});

test('workbench: a rejected write stays an error after reloading the session', async ({
  workbench,
}) => {
  const { window, workspace } = workbench;
  await window.getByTestId('composer-input').fill('create hello.txt');
  await window.getByTestId('composer-send').click();
  await window.getByTestId('approval-deny').click();
  await expect(window.getByTestId('composer-input')).toBeEnabled();
  await expect(window.getByTestId('tool-card').locator('.tool-state')).toHaveText('failed');
  await expect(window.locator('.change-row')).toHaveCount(0);
  await window.reload();
  await expect(window.getByTestId('composer-input')).toBeEnabled();
  const tool = window.getByTestId('tool-card');
  await expect(tool.locator('.tool-state')).toHaveText('failed');
  await expect(tool.locator('.tool-error-summary')).toBeVisible();
  await expect(window.locator('.change-row')).toHaveCount(0);
  await expect(readFile(path.join(workspace, 'hello.txt'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('workbench: panels collapse locally, restore at the stage edge, and keep Ctrl B/J', async ({
  workbench,
}) => {
  const { window, mock } = workbench;
  const input = window.getByTestId('composer-input');
  const headerControls = window.locator('.session-header').getByRole('button', {
    name: /^(Hide|Show|Toggle) (sessions|inspector)$/,
  });
  const panels = [
    { name: 'sessions', id: 'sessions-panel', key: 'Control+b', other: 'inspector' },
    { name: 'inspector', id: 'inspector', key: 'Control+j', other: 'sessions-panel' },
  ];
  await input.fill('A draft survives panel changes.');
  await expect(headerControls).toHaveCount(0);

  for (const { name, id, key, other } of panels) {
    const panel = window.locator(`#${id}`);
    const hide = panel.getByRole('button', { name: `Hide ${name}`, exact: true });
    const restore = window
      .locator('.stage')
      .getByRole('button', { name: `Show ${name}`, exact: true });
    await expect(hide).toHaveAttribute('aria-controls', id);
    await expect(hide).toHaveAttribute('aria-expanded', 'true');
    await hide.click();
    await expect(panel).toHaveCount(0);
    await expect(window.locator(`#${other}`)).toBeVisible();
    await expect(restore).toBeVisible();
    await expect(restore).toHaveAttribute('aria-controls', id);
    await expect(restore).toHaveAttribute('aria-expanded', 'false');
    await expect(headerControls).toHaveCount(0);
    await restore.click();
    await expect(panel).toBeVisible();
    await expect(restore).toHaveCount(0);

    await input.focus();
    await window.keyboard.press(key);
    await expect(panel).toHaveCount(0);
    await expect(restore).toBeVisible();
    await window.keyboard.press(key);
    await expect(panel).toBeVisible();
    await expect(restore).toHaveCount(0);
    await expect(input).toHaveValue('A draft survives panel changes.');
  }

  // A reload must honour the collapsed preferences, not put toggles back in the header.
  await window.getByRole('button', { name: 'Hide sessions', exact: true }).click();
  await window.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await window.reload();
  await expect(window.getByTestId('composer-input')).toBeEnabled();
  for (const { name, id } of panels) {
    await expect(window.locator(`#${id}`)).toHaveCount(0);
    await expect(window.getByRole('button', { name: `Show ${name}`, exact: true })).toBeVisible();
  }
  await expect(headerControls).toHaveCount(0);
  expect(mock.requests).toHaveLength(0);
});

async function expectNoHorizontalOverflow(window: Page): Promise<void> {
  await expect
    .poll(() =>
      window.evaluate(() => {
        const nodes = [
          document.documentElement,
          document.body,
          ...Array.from(
            document.querySelectorAll<HTMLElement>('.stage, .session-header, .composer'),
          ),
        ];
        return nodes.map((node) => Math.max(0, node.scrollWidth - node.clientWidth));
      }),
    )
    .toEqual([0, 0, 0, 0, 0]);
}

test('workbench: light and dark tokens paint the UI without overflow at 1360 and 720', async ({
  workbench,
}, testInfo) => {
  const { window, mock } = workbench;
  const painted: Array<{ background: string; composer: string; ink: string; tokens: string[] }> =
    [];
  for (const theme of ['flour', 'cocoa']) {
    await resize(workbench, 1360);
    for (const name of ['sessions', 'inspector']) {
      const restore = window.getByRole('button', { name: `Show ${name}`, exact: true });
      if (await restore.count()) await restore.click();
    }
    if (theme === 'cocoa') await window.getByRole('button', { name: 'Change palette' }).click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(window.locator('html')).toHaveCSS(
      'color-scheme',
      theme === 'flour' ? 'light' : 'dark',
    );
    const colors = await window.locator('.composer').evaluate((composer) => {
      const root = getComputedStyle(document.documentElement);
      const input = composer.querySelector('textarea');
      if (!input) throw new Error('The composer must contain its input');
      const tokens = ['--bg', '--panel', '--text', '--muted', '--accent', '--border'].map((name) =>
        root.getPropertyValue(name).trim(),
      );
      return {
        tokens,
        valid: tokens.every((value) => value !== '' && CSS.supports('color', value)),
        background: getComputedStyle(document.body).backgroundColor,
        composer: getComputedStyle(composer).backgroundColor,
        ink: getComputedStyle(input).color,
      };
    });
    expect(colors.valid, `${theme} must resolve real color tokens`).toBe(true);
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.composer).not.toBe('rgba(0, 0, 0, 0)');
    painted.push(colors);
    await expectNoHorizontalOverflow(window);
    await window.screenshot({ path: testInfo.outputPath(`workbench-${theme}-1360.png`) });

    await resize(workbench, 720);
    await expect(window.getByRole('button', { name: 'Show sessions', exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Show inspector', exact: true })).toBeVisible();
    await expect(window.getByTestId('composer-input')).toBeInViewport();
    await expect(window.getByRole('button', { name: 'Add context', exact: true })).toBeInViewport();
    await expect(window.getByTestId('composer-send')).toBeInViewport();
    for (const { label } of starters) {
      await expect(window.getByRole('button', { name: new RegExp(`^${label}`) })).toBeInViewport();
    }
    await expectNoHorizontalOverflow(window);
    await window.screenshot({ path: testInfo.outputPath(`workbench-${theme}-720.png`) });
  }
  expect(painted[0]?.background).not.toBe(painted[1]?.background);
  expect(painted[0]?.composer).not.toBe(painted[1]?.composer);
  expect(painted[0]?.ink).not.toBe(painted[1]?.ink);
  expect(painted[0]?.tokens).not.toEqual(painted[1]?.tokens);
  expect(mock.requests).toHaveLength(0);
});
