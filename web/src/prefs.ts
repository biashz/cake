export type ThemeName = 'night' | 'parchment';

export interface UiPrefs {
  theme: ThemeName;
  railOpen: boolean;
  inspectorOpen: boolean;
}

const STORAGE_KEY = 'cake.ui.v1';

const DEFAULTS: UiPrefs = { theme: 'parchment', railOpen: true, inspectorOpen: true };

export function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      theme: parsed.theme === 'night' ? 'night' : 'parchment',
      railOpen: typeof parsed.railOpen === 'boolean' ? parsed.railOpen : true,
      inspectorOpen: typeof parsed.inspectorOpen === 'boolean' ? parsed.inspectorOpen : true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are best-effort; a locked-down renderer should still work.
  }
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
}
