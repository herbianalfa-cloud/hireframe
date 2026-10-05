import { JOB_SORTS, SORT_LABELS, type JobSort } from './sort';

export const SELECT_CLASS = 'h-11 rounded-md border bg-background px-3 text-sm';

/** A labelled native select. `hiddenLabel` extends the name for screen readers (a list's name). */
export function FilterSelect<T extends string>({
  label,
  hiddenLabel,
  value,
  options,
  emptyLabel,
  disabled = false,
  onChange,
}: {
  label: string;
  hiddenLabel?: string;
  value: T | '';
  options: readonly { value: T; label: string }[];
  /** The option meaning "no filter" (value ''); leave out when a choice is always required. */
  emptyLabel?: string;
  disabled?: boolean;
  onChange: (value: T | '') => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span>
        {label}
        {hiddenLabel ? <span className="sr-only"> {hiddenLabel}</span> : null}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => {
          // The options are the only values the element can hold.
          onChange(event.target.value as T | '');
        }}
        className={SELECT_CLASS}
      >
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : null}
        {options.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const SORT_OPTIONS = JOB_SORTS.map((value) => ({ value, label: SORT_LABELS[value] }));

/** The sort select Today and Jobs share. */
export function SortSelect({
  value,
  hiddenLabel,
  disabled,
  onChange,
}: {
  value: JobSort;
  hiddenLabel?: string;
  disabled?: boolean;
  onChange: (sort: JobSort) => void;
}) {
  return (
    <FilterSelect
      label="Sort"
      {...(hiddenLabel ? { hiddenLabel } : {})}
      value={value}
      options={SORT_OPTIONS}
      {...(disabled ? { disabled } : {})}
      onChange={(next) => {
        if (next) onChange(next);
      }}
    />
  );
}
