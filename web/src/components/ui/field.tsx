import { useId, type ReactNode } from 'react';

import { Label } from './label';

export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
}

/** A label, a control, optional hint and inline error, wired together with ids. */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const describedBy =
    [hint ? `${id}-hint` : undefined, error ? `${id}-error` : undefined]
      .filter((value) => value !== undefined)
      .join(' ') || undefined;
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1.5">
        {children({
          id,
          'aria-describedby': describedBy,
          'aria-invalid': error ? true : undefined,
        })}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
