import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const root = process.cwd();
const mainEntry = path.join(root, 'dist', 'desktop', 'main.cjs');

// Only the built CSS can answer whether the name survives, because layout is
// not computed in jsdom. The directory here is long enough to overflow.
const DEEP = path.join(
  'src',
  'components',
  'deeply',
  'nested',
  'in',
  'a',
  'very',
  'long',
  'directory',
);
const DEEP_FILE = `${DEEP.replaceAll(path.sep, '/')}/Inspector.tsx`;

test('an empty centre names itself, and a deep path gives way in the directory', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cake-empty-deep-ws-'));
  const userData = await mkdtemp(path.join(tmpdir(), 'cake-empty-deep-data-'));
  await mkdir(path.join(workspace, DEEP), { recursive: true });
  await writeFile(path.join(workspace, DEEP_FILE), 'export const x = 1;\n', 'utf8');
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
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4597',
      CAKE_USER_DATA: userData,
    },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 });

    // A session with no turns is a state, not a placeholder waiting for typing.
    const empty = window.getByTestId('transcript-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('No turns yet.');
    await expect(window.getByText('Ask cake to change the code…')).toBeVisible();

    await window.getByRole('tab', { name: 'Files' }).click();
    const row = window.locator('.file-row');
    await expect(row).toHaveCount(1);

    // The full path stays available where it is read programmatically, and the
    // two spans show which half was allowed to shrink.
    await expect(row).toHaveAttribute('title', `Add @${DEEP_FILE}`);
    const room = await row.evaluate((node) => {
      const dir = node.querySelector<HTMLElement>('.file-dir');
      const name = node.querySelector<HTMLElement>('.file-name');
      if (!dir || !name) throw new Error('the row does not split directory from name');
      const numbers = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
      // The surface a span is read on is whatever it is actually painted over,
      // which is not the token the stylesheet names.
      const surfaceOf = (el: HTMLElement) => {
        let cursor: HTMLElement | null = el;
        while (cursor) {
          const parts = numbers(getComputedStyle(cursor).backgroundColor);
          if (parts.length >= 4 && (parts[3] ?? 0) > 0) return parts.slice(0, 3);
          cursor = cursor.parentElement;
        }
        return [255, 255, 255];
      };
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (rgb: number[]) =>
        0.2126 * channel(rgb[0] ?? 0) +
        0.7152 * channel(rgb[1] ?? 0) +
        0.0722 * channel(rgb[2] ?? 0);
      const aa = (el: HTMLElement) => {
        const ink = numbers(getComputedStyle(el).color).slice(0, 3);
        const surface = surfaceOf(el);
        const l1 = luminance(ink);
        const l2 = luminance(surface);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      return {
        rowRight: node.getBoundingClientRect().right,
        nameRight: name.getBoundingClientRect().right,
        dirGaveWay: dir.scrollWidth > dir.clientWidth,
        name: name.textContent,
        dirContrast: Math.round(aa(dir) * 100) / 100,
        nameContrast: Math.round(aa(name) * 100) / 100,
        labelSize: getComputedStyle(node).fontSize,
      };
    });
    expect(room.name).toBe('Inspector.tsx');
    expect(room.dirGaveWay).toBe(true);
    expect(room.nameRight).toBeLessThanOrEqual(room.rowRight);
    // 10.5px text, so AA asks 4.5:1 of both halves. Truncation is not a reason to
    // paint a path lighter than a person can read.
    expect(room.labelSize).toBe('10.5px');
    expect(room.dirContrast, 'directory half').toBeGreaterThanOrEqual(4.5);
    expect(room.nameContrast, 'name half').toBeGreaterThanOrEqual(4.5);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
