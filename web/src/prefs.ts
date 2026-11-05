export type ThemeName = 'flour' | 'cocoa' | 'auto';

export const THEME_ORDER: ThemeName[] = ['flour', 'cocoa', 'auto'];

export const THEME_LABEL: Record<ThemeName, string> = {
  flour: 'Flour',
  cocoa: 'Cocoa',
  auto: 'Follow system',
};

export interface UiPrefs {
  theme: ThemeName;
  railOpen: boolean;
  inspectorOpen: boolean;
  railWidth: number;
  inspectorWidth: number;
  /** Command palette ids, most recent first. */
  recentActions: string[];
}

const STORAGE_KEY = 'cake.ui.v2';
/** Renamed to flour/cocoa in the Coupe redesign; older builds wrote this key. */
const LEGACY_STORAGE_KEY = 'cake.ui.v1';

const RAIL_DEFAULT = 280;
const INSPECTOR_DEFAULT = 328;
export const RAIL_RANGE: [number, number] = [200, 460];
export const INSPECTOR_RANGE: [number, number] = [260, 560];
export const RAIL_RESET = RAIL_DEFAULT;
export const INSPECTOR_RESET = INSPECTOR_DEFAULT;

const DEFAULTS: UiPrefs = {
  theme: 'flour',
  railOpen: true,
  inspectorOpen: true,
  railWidth: RAIL_DEFAULT,
  inspectorWidth: INSPECTOR_DEFAULT,
  recentActions: [],
};

/** Stored names from before the palette rename still resolve. */
function readTheme(value: unknown): ThemeName {
  if (value === 'cocoa' || value === 'night') return 'cocoa';
  if (value === 'auto') return 'auto';
  return 'flour';
}

function readWidth(value: unknown, [min, max]: [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function migrate(): Partial<UiPrefs> | null {
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacy) return null;
    const parsed = JSON.parse(legacy) as Partial<UiPrefs>;
    localStorage.setItem(STORAGE_KEY, legacy);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function loadPrefs(): UiPrefs {
  const raw = localStorage.getItem(STORAGE_KEY) ?? migrate();
  if (raw === null) return DEFAULTS;
  try {
    return normalize(typeof raw === 'string' ? (JSON.parse(raw) as Partial<UiPrefs>) : raw);
  } catch {
    return DEFAULTS;
  }
}

function normalize(parsed: Partial<UiPrefs>): UiPrefs {
  return {
    theme: readTheme(parsed.theme),
    railOpen: typeof parsed.railOpen === 'boolean' ? parsed.railOpen : true,
    inspectorOpen: typeof parsed.inspectorOpen === 'boolean' ? parsed.inspectorOpen : true,
    railWidth: readWidth(parsed.railWidth, RAIL_RANGE, RAIL_DEFAULT),
    inspectorWidth: readWidth(parsed.inspectorWidth, INSPECTOR_RANGE, INSPECTOR_DEFAULT),
    recentActions: Array.isArray(parsed.recentActions)
      ? parsed.recentActions
          .filter((id): id is string => typeof id === 'string')
          .slice(0, RECENT_LIMIT)
      : [],
  };
}

export const RECENT_LIMIT = 6;

/** Most recent first, no duplicates, capped so the group never crowds the palette. */
export function pushRecent(ids: string[], id: string): string[] {
  return [id, ...ids.filter((item) => item !== id)].slice(0, RECENT_LIMIT);
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are best-effort; a locked-down renderer should still work.
  }
}

export function clampRailWidth(value: number): number {
  return readWidth(value, RAIL_RANGE, RAIL_DEFAULT);
}

export function clampInspectorWidth(value: number): number {
  return readWidth(value, INSPECTOR_RANGE, INSPECTOR_DEFAULT);
}

export function nextTheme(current: ThemeName): ThemeName {
  const index = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'flour';
}

function systemTheme(): 'flour' | 'cocoa' {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'cocoa' : 'flour';
}

let resolved: 'flour' | 'cocoa' = 'flour';
let media: MediaQueryList | undefined;

/**
 * `auto` is never written to the data-theme attribute — the resolved system
 * palette is, so every `:root[data-theme=…]` rule keeps matching.
 */
export function applyTheme(theme: ThemeName): void {
  const next = theme === 'auto' ? systemTheme() : theme;
  resolved = next;
  document.documentElement.dataset.theme = next;
  if (theme === 'auto') {
    media ??= window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', onSystemChange);
  } else {
    media?.removeEventListener('change', onSystemChange);
  }
}

function onSystemChange() {
  const current = loadPrefs().theme;
  if (current === 'auto') applyTheme('auto');
}

export function currentResolvedTheme(): 'flour' | 'cocoa' {
  return resolved;
}
