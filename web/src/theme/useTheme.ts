import { useSyncExternalStore } from 'react';

import {
  applyTheme,
  DEFAULT_THEME,
  isThemePreference,
  writeThemePreference,
  type ThemePreference,
} from './theme';

// `<html data-theme>` is the single source of truth, so every switcher stays in sync.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ThemePreference {
  const current = document.documentElement.dataset.theme;
  return isThemePreference(current) ? current : DEFAULT_THEME;
}

export function setTheme(pref: ThemePreference): void {
  applyTheme(pref);
  writeThemePreference(pref);
  for (const listener of listeners) listener();
}

export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  return [useSyncExternalStore(subscribe, getSnapshot), setTheme];
}
