import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { startMockAnthropic } from './mock-anthropic';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

// A real 1x1 PNG: the composer reads the file's bytes, so they have to be a picture.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

test.setTimeout(240_000);

test('a picked picture goes on the turn, stays with it, and exports beside the Markdown', async () => {
  const mock = await startMockAnthropic();
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-image-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-image-data-'));
  await writeFile(
    path.join(userData, 'state.json'),
    JSON.stringify({ lastWorkspace: workspace }),
    'utf8',
  );

  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      // Pin the provider so a developer's real key cannot bypass the mock. The default
      // anthropic model is a vision one, which is what lets Attach out of the dark.
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

    await input.fill('what is in this shot?');
    // The picker's own input: hidden, but the button in front of it is only reachable
    // when the model reports vision, which is the gate this spec is checking.
    await window.getByTestId('composer-attach-input').setInputFiles({
      name: 'shot.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await expect(window.locator('.attach-chip')).toHaveCount(1);

    await window.getByTestId('composer-send').click();
    // Sending takes the staged picture off the composer: it belongs to the turn now.
    await expect(window.locator('.attach-chip')).toHaveCount(0);

    await expect(window.getByTestId('approval-card')).toBeVisible({ timeout: 30_000 });
    await window.getByTestId('approval-allow').click();
    await expect(window.getByTestId('bubble-assistant').last()).toContainText(
      'Created hello.txt.',
      { timeout: 30_000 },
    );

    // The bytes left the app in the shape the provider reads.
    expect(mock.requests[0]?.imageParts).toBe(1);

    // And they stay with the words that asked about them.
    const pictures = window.getByRole('list', { name: 'Pictures sent with this turn' });
    await expect(pictures).toHaveCount(1);
    await expect(pictures.locator('img')).toHaveCount(1);

    await window.locator('.session-row.is-active').getByLabel('Export session as Markdown').click();
    const note = window.getByTestId('entry-note').filter({ hasText: 'transcript →' });
    await expect(note.first()).toBeVisible({ timeout: 30_000 });
    // The note cannot be vague about the second file it wrote.
    await expect(note.first()).toContainText('1 picture');

    const dir = path.join(workspace, '.cake', 'exports');
    const names = await readdir(dir);
    expect(names).toContain('assets');
    const assets = await readdir(path.join(dir, 'assets'));
    expect(assets).toHaveLength(1);
    const written = await readFile(path.join(dir, 'assets', assets[0] ?? ''));
    expect(Buffer.compare(written, PNG)).toBe(0);

    const markdown = await readFile(
      path.join(dir, names.find((name) => name.endsWith('.md')) ?? ''),
      'utf8',
    );
    expect(markdown).toContain(`assets/${assets[0]}`);
    expect(markdown).toContain('what is in this shot?');
  } finally {
    await app.close();
    await mock.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
