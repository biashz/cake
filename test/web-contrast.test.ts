import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The contrast sweep Stage 5 owed. It reads the stylesheet rather than a rendered
 * page on purpose: what it locks in are properties of the token set itself — a
 * declaration that references itself, and how far a grey sits from the surfaces it
 * is painted on — and both are answerable from the source with no browser in the
 * loop. The rule that a *specific class* resolves to a specific token is the live
 * window's job, and e2e/night-scrim.spec.ts does that one.
 */
const css = readFileSync(path.join(import.meta.dirname, '../web/src/styles.css'), 'utf8');

function block(head: string): string {
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`no such block: ${head}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${head}`);
}

function tokens(head: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block(head).split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);/.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], m[2]);
  }
  return out;
}

const shared = tokens(':root {\n');
const themes: Array<[string, Map<string, string>]> = [
  ['flour', new Map([...shared, ...tokens(':root,\n:root[data-theme="flour"] {')])],
  ['cocoa', new Map([...shared, ...tokens(':root[data-theme="cocoa"] {')])],
];

type RGBA = [r: number, g: number, b: number, a: number];

function channels(value: string): RGBA | null {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    const parts = [0, 2, 4, 6].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 255];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (fn?.[1]) {
    const parts = fn[1]
      .split(/[\s,/]+/)
      .filter((p) => p !== '')
      .map(Number);
    const [r, g, b, a] = parts;
    if ([r, g, b].some((v) => v === undefined || Number.isNaN(v))) return null;
    return [r ?? 0, g ?? 0, b ?? 0, a === undefined ? 255 : Math.round(a * 255)];
  }
  return null;
}

/** The colour a translucent token actually becomes once it lies on another one. */
function flatten(map: Map<string, string>, token: string, overToken: string): RGBA {
  const ink = channels(read(map, token));
  const surface = channels(read(map, overToken));
  if (!ink || !surface) throw new Error(`cannot parse ${token} or ${overToken}`);
  const alpha = ink[3] / 255;
  return [
    Math.round(ink[0] * alpha + surface[0] * (1 - alpha)),
    Math.round(ink[1] * alpha + surface[1] * (1 - alpha)),
    Math.round(ink[2] * alpha + surface[2] * (1 - alpha)),
    255,
  ];
}

function read(map: Map<string, string>, token: string): string {
  const value = map.get(token);
  if (value === undefined) throw new Error(`token ${token} is not declared in this theme`);
  return value;
}

function luminance(rgb: RGBA): number {
  const scaled = rgb.slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (scaled[0] ?? 0) + 0.7152 * (scaled[1] ?? 0) + 0.0722 * (scaled[2] ?? 0);
}

function between(ink: RGBA, surface: RGBA): number {
  const l1 = luminance(ink);
  const l2 = luminance(surface);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * Ratio between an ink token and a surface token, with any alpha in the ink
 * composited onto the surface first — which is what the eye sees, and what an
 * opaque-only measurement gets wrong for the diff rows.
 */
function ratio(map: Map<string, string>, inkToken: string, surfaceToken: string): number {
  const surface = channels(read(map, surfaceToken));
  if (!surface) throw new Error(`cannot parse ${surfaceToken}`);
  return between(flatten(map, inkToken, surfaceToken), surface);
}

describe('theme token blocks', () => {
  it('never declares a custom property in terms of itself', () => {
    // A cycle is invalid at computed-value time, so the property stops applying
    // and every rule that used it falls back to its initial value in silence. The
    // night theme's overlay painted nothing at all for exactly this reason.
    for (const [theme, map] of themes) {
      const cyclic = [...map].filter(([name, value]) => value.includes(`var(${name})`));
      expect(cyclic, `${theme}: self-referencing tokens`).toEqual([]);
    }
  });

  it('dims the overlay in the night theme too', () => {
    for (const [theme, map] of themes) {
      const scrim = channels(read(map, '--scrim'));
      if (!scrim) throw new Error(`${theme}: --scrim is not a colour this sweep can read`);
      // The rule that consumes it is `background: var(--scrim)`, so a value that
      // parses but clears is the same as no scrim at all.
      expect(scrim[3], `${theme}: --scrim is fully transparent`).toBeGreaterThan(0);
    }
  });
});

describe('contrast of the text the interface paints', () => {
  // Every pair here is set at body or label size, so the AA floor is 4.5:1.
  const textPairs: Array<[string, string, string]> = [
    ['--text', '--bg', 'body copy on the counter'],
    ['--text', '--panel', 'body copy in a panel'],
    ['--text-soft', '--panel', 'softer text in a panel'],
    ['--text-soft', '--bg', 'softer text on the counter'],
    ['--muted', '--panel', 'secondary labels in a panel'],
    ['--muted', '--bg', 'secondary labels on the counter'],
    ['--muted', '--panel-2', 'secondary labels on a raised row'],
    ['--muted', '--panel-3', 'secondary labels on the deepest surface'],
    ['--accent', '--panel', 'raspberry action text'],
    ['--accent', '--bg', 'raspberry action text on the counter'],
    ['--accent-strong', '--panel', 'pressed action text'],
    ['--accent-ink', '--accent', 'text on a filled accent control'],
    ['--ok', '--panel', 'success text'],
    ['--bad', '--panel', 'failure text'],
    ['--warn', '--panel', 'warning text'],
    ['--info', '--panel', 'info text'],
  ];

  it.each(textPairs)('keeps %s on %s at the AA floor (%s)', (ink, surface, label) => {
    for (const [theme, map] of themes) {
      expect(ratio(map, ink, surface), `${theme}: ${label}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('reads the diff ink against the tinted row, not the bare tint', () => {
    // The tint is 11-14% alpha over the panel. Treating it as opaque measures the
    // line text against a saturated green and reports a failure that no user sees.
    for (const [theme, map] of themes) {
      const pairs: Array<[string, string]> = [
        ['--add-fg', '--add-bg'],
        ['--remove-fg', '--remove-bg'],
      ];
      for (const [ink, tint] of pairs) {
        const row = flatten(map, tint, '--panel');
        const text = channels(read(map, ink));
        if (!text) throw new Error(`${theme}: ${ink} is not a colour this sweep can read`);
        expect(between(text, row), `${theme}: ${ink} on its tinted row`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('keeps the truncated half of a file path readable', () => {
    // The directory gives way in a narrow panel, which makes it the part people
    // still have to be able to read. --faint is 3.70:1 on a raised row at the
    // label size, so this text takes --muted and stays a step under the name.
    for (const [theme, map] of themes) {
      for (const surface of ['--panel', '--panel-2']) {
        expect(
          ratio(map, '--muted', surface),
          `${theme}: muted directory on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
