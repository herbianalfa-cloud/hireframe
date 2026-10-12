import { Loader2 } from 'lucide-react';
import { useState, type SubmitEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { checkCvHeader, type CvHeaderErrors, type CvHeaderValues } from '@/services/fact-writes';
import { saveCvHeader, type CvHeaderView } from '@/services/profile';

import { useCvHeader } from './hooks';

type Message = { kind: 'ok' | 'error'; text: string } | undefined;

/** The form's starting values: the stored header, or whatever strings an unreadable one holds. */
function startingValues(stored: CvHeaderView | null): CvHeaderValues {
  const header = stored?.header;
  const text = (key: string): string => {
    const value: unknown = stored?.raw[key];
    return typeof value === 'string' ? value : '';
  };
  const rawLinks: unknown = stored?.raw.links;
  const links =
    header?.links ??
    (Array.isArray(rawLinks) ? rawLinks.filter((link) => typeof link === 'string') : []);
  return {
    name: header?.name ?? text('name'),
    email: header?.email ?? text('email'),
    phone: header?.phone ?? text('phone'),
    location: header?.location ?? text('location'),
    links: [links[0] ?? '', links[1] ?? '', links[2] ?? ''],
  };
}

/** Changes when the stored header does, so the form can start again from it. */
function storedKey(stored: CvHeaderView | null): string {
  if (stored === null) return 'none';
  const at: unknown = stored.raw.updatedAt;
  const seconds =
    typeof at === 'object' && at !== null && 'seconds' in at ? String(at.seconds) : 'pending';
  return `${seconds}:${stored.header === null ? 'invalid' : 'valid'}`;
}

/**
 * The CV header (M7): the contact block code puts at the top of every CV and cover note. The
 * model never sees or writes it. Stored in Firebase only, never in the repo.
 */
export function CvHeaderCard() {
  const state = useCvHeader();
  // Kept here so it outlives the form's reset when the stored value changes.
  const [message, setMessage] = useState<Message>();
  if (state.status === 'loading') {
    return (
      <div role="status" aria-label="Loading CV header">
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-danger">
        {state.message}
      </p>
    );
  }
  return <CvHeaderForm stored={state.data} message={message} setMessage={setMessage} />;
}

function CvHeaderForm({
  stored,
  message,
  setMessage,
}: {
  stored: CvHeaderView | null;
  message: Message;
  setMessage: (message: Message) => void;
}) {
  const [values, setValues] = useState<CvHeaderValues>(() => startingValues(stored));
  const [errors, setErrors] = useState<CvHeaderErrors>({});
  // A new stored header (saved here or elsewhere) starts the fields again from it. Not a remount
  // by key: that would drop focus from Save and rebuild the live region that says "Saved".
  const key = storedKey(stored);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setValues(startingValues(stored));
    setErrors({});
  }
  const [pending, setPending] = useState(false);
  const repairing = stored !== null && stored.header === null;

  function set(patch: Partial<Omit<CvHeaderValues, 'links'>>) {
    setValues((previous) => ({ ...previous, ...patch }));
    setErrors({});
    setMessage(undefined);
  }

  function setLink(slot: 0 | 1 | 2, value: string) {
    setValues((previous) => {
      const links: [string, string, string] = [...previous.links];
      links[slot] = value;
      return { ...previous, links };
    });
    setErrors({});
    setMessage(undefined);
  }

  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    const checked = checkCvHeader(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      setMessage({ kind: 'error', text: 'Fix the highlighted fields, then save.' });
      return;
    }
    setPending(true);
    setMessage(undefined);
    try {
      await saveCvHeader(values, stored);
      setMessage({ kind: 'ok', text: 'Saved. New CVs use it.' });
    } catch {
      setMessage({ kind: 'error', text: "Couldn't save. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="cv-header-title" className="rounded-lg border bg-surface p-4 md:p-5">
      <h2 id="cv-header-title" className="text-sm font-medium">
        CV header
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The contact block at the top of every CV and cover note. It is added by code: the model
        never sees it.{' '}
        {stored === null
          ? 'A CV can’t be written until you save a name and an email.'
          : repairing
            ? 'The saved header can’t be used as it is. Check the fields and save it again.'
            : null}
      </p>
      <form
        noValidate
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Full name" error={errors.name}>
            {(control) => (
              <Input
                {...control}
                autoComplete="name"
                maxLength={80}
                value={values.name}
                onChange={(event) => {
                  set({ name: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label="Email" error={errors.email}>
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="email"
                maxLength={120}
                value={values.email}
                onChange={(event) => {
                  set({ email: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label="Phone (optional)" error={errors.phone}>
            {(control) => (
              <Input
                {...control}
                type="tel"
                autoComplete="tel"
                maxLength={40}
                value={values.phone}
                onChange={(event) => {
                  set({ phone: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label="Location (optional)" error={errors.location}>
            {(control) => (
              <Input
                {...control}
                autoComplete="address-level2"
                maxLength={80}
                value={values.location}
                onChange={(event) => {
                  set({ location: event.target.value });
                }}
              />
            )}
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {([0, 1, 2] as const).map((slot) => (
            <Field
              key={slot}
              label={`Link ${String(slot + 1)} (optional)`}
              hint={slot === 0 ? 'A full https:// link, such as a portfolio.' : undefined}
              error={errors[`link${String(slot)}` as 'link0' | 'link1' | 'link2']}
            >
              {(control) => (
                <Input
                  {...control}
                  type="url"
                  inputMode="url"
                  maxLength={200}
                  value={values.links[slot]}
                  onChange={(event) => {
                    setLink(slot, event.target.value);
                  }}
                />
              )}
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* aria-disabled, not disabled: a disabled button would drop focus while saving. */}
          <Button type="submit" aria-disabled={pending} className="aria-disabled:opacity-50">
            {pending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
            Save CV header
          </Button>
          <p aria-live="polite" className="text-sm">
            {message ? (
              <span className={message.kind === 'error' ? 'text-danger' : 'text-foreground'}>
                {message.text}
              </span>
            ) : null}
          </p>
        </div>
      </form>
    </section>
  );
}
