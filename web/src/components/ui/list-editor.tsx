import { Plus, X } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import { Input } from './input';
import { Label } from './label';

export const LIST_EDITOR_MAX_ITEMS = 100;
export const LIST_EDITOR_MAX_LENGTH = 120;

/**
 * Editor for a list of short strings: removable chips plus an input that adds on Enter or the
 * Add button. Trims, rejects duplicates (case-insensitive), and caps at 100 items of 120 characters.
 */
export function ListEditor({
  label,
  items,
  onChange,
  hint,
  error,
  placeholder,
  className,
}: {
  label: string;
  items: readonly string[];
  onChange: (items: string[]) => void;
  hint?: string;
  error?: string | undefined;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [localError, setLocalError] = useState<string>();

  const shownError = localError ?? error;
  const full = items.length >= LIST_EDITOR_MAX_ITEMS;
  const describedBy =
    [hint ? `${id}-hint` : undefined, shownError ? `${id}-error` : undefined]
      .filter((value) => value !== undefined)
      .join(' ') || undefined;

  function add() {
    const value = draft.trim();
    if (!value) return;
    if (items.some((item) => item.toLowerCase() === value.toLowerCase())) {
      setLocalError(`"${value}" is already in the list.`);
      return;
    }
    if (full) {
      setLocalError(`A list can hold up to ${String(LIST_EDITOR_MAX_ITEMS)} items.`);
      return;
    }
    onChange([...items, value]);
    setDraft('');
    setLocalError(undefined);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    // Enter adds an item; it must not submit the surrounding form.
    event.preventDefault();
    add();
  }

  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      {items.length > 0 ? (
        <ul aria-label={`${label}, current items`} className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="inline-flex max-w-full items-center gap-1 rounded-md border bg-surface-raised py-1 pr-1 pl-2.5 text-sm"
            >
              <span className="min-w-0 break-words">{item}</span>
              <button
                type="button"
                aria-label={`Remove ${item}`}
                onClick={() => {
                  onChange(items.filter((other) => other !== item));
                  setLocalError(undefined);
                }}
                className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 ease-out after:absolute after:-inset-3 after:content-[''] hover:text-foreground"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Input
          id={id}
          value={draft}
          maxLength={LIST_EDITOR_MAX_LENGTH}
          placeholder={placeholder ?? 'Type and press Enter'}
          aria-describedby={describedBy}
          aria-invalid={shownError ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setLocalError(undefined);
          }}
          onKeyDown={onKeyDown}
        />
        <Button
          type="button"
          variant="secondary"
          onClick={add}
          disabled={!draft.trim()}
          aria-label={`Add to ${label}`}
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {shownError ? (
        <p id={`${id}-error`} className={cn('mt-1 text-xs text-danger')}>
          {shownError}
        </p>
      ) : null}
    </div>
  );
}
