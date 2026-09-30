/**
 * Theme preference (docs/DESIGN.md): dark by default, light on request, or follow the
 * system `prefers-color-scheme`. Stored per browser; storage may be missing or throw
 * (private mode, blocked site data), so every access is guarded and falls back to dark.
 */
export const THEME_PREFERENCES = ['dark', 'light', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_THEME: ThemePreference = 'dark';
export const THEME_STORAGE_KEY = 'hireframe.theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((pref) => pref === value);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = storage()?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeThemePreference(pref: ThemePreference): void {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Not persisted; the choice still applies for this page view.
  }
}

export function applyTheme(
  pref: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.theme = pref;
}
