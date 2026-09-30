import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, readThemePreference, THEME_STORAGE_KEY, writeThemePreference } from './theme';
import { ThemeSwitcher } from './ThemeSwitcher';

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme preference', () => {
  it('defaults to dark', () => {
    expect(readThemePreference()).toBe('dark');
  });

  it('ignores unknown stored values', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readThemePreference()).toBe('dark');
  });

  it('round-trips a stored preference', () => {
    writeThemePreference('light');
    expect(readThemePreference()).toBe('light');
  });

  it('falls back to dark and does not throw when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => {
      writeThemePreference('light');
    }).not.toThrow();
    expect(readThemePreference()).toBe('dark');
  });

  it('applies the preference to <html data-theme>', () => {
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('system');
  });
});

describe('ThemeSwitcher', () => {
  it('starts on dark and persists a new choice', async () => {
    render(<ThemeSwitcher />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Dark' }).checked).toBe(true);

    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));

    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Light' }).checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('still switches the theme when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<ThemeSwitcher />);
    await userEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(document.documentElement.dataset.theme).toBe('system');
  });
});
