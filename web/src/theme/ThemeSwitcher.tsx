import { Monitor, Moon, Sun } from 'lucide-react';
import { useId } from 'react';

import { cn } from '@/lib/utils';

import type { ThemePreference } from './theme';
import { useTheme } from './useTheme';

const OPTIONS = [
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
] as const satisfies readonly { value: ThemePreference; label: string; Icon: typeof Moon }[];

/** Native radio group: keyboard (arrow keys) and screen readers work without extra ARIA. */
export function ThemeSwitcher({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const name = useId();

  return (
    <fieldset className={cn('flex rounded-md border bg-surface p-0.5', className)}>
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => (
        <label
          key={value}
          className="flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors duration-150 ease-out has-checked:bg-surface-raised has-checked:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
        >
          <input
            type="radio"
            name={name}
            value={value}
            checked={theme === value}
            onChange={() => {
              setTheme(value);
            }}
            className="sr-only"
          />
          <Icon aria-hidden="true" className="size-3.5" />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
