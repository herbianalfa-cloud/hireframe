import { ChevronRight, LogOut } from 'lucide-react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { ThemeSwitcher } from '@/theme/ThemeSwitcher';

import { NAV_ITEMS, type NavItem } from './nav';
import { useSession } from './session';

/** Placeholder screen with a designed empty state; real content arrives in M2–M6. */
export function EmptyPage({ item }: { item: NavItem }) {
  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        {item.label}
      </h1>
      <div className="mt-6 flex flex-col items-center rounded-lg border border-dashed bg-surface px-6 py-16 text-center">
        <item.Icon aria-hidden="true" className="size-6 text-muted-foreground" />
        <h2 className="mt-3 text-sm font-medium">{item.empty.title}</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{item.empty.body}</p>
      </div>
    </section>
  );
}

/** Phone "More" tab: the screens that don't fit the tab bar, theme and sign-out. */
export function MorePage() {
  const { user, signOut } = useSession();
  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        More
      </h1>
      <ul className="mt-6 divide-y rounded-lg border bg-surface">
        {NAV_ITEMS.filter((item) => !item.inTabBar).map((item) => (
          <li key={item.path}>
            <Link to={item.path} className="flex min-h-12 items-center gap-3 px-4 text-sm">
              <item.Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="flex-1">{item.label}</span>
              <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
      <h2 className="mt-8 mb-2 text-sm font-medium">Appearance</h2>
      <ThemeSwitcher />
      <h2 className="mt-8 mb-2 text-sm font-medium">Account</h2>
      <p className="truncate text-sm text-muted-foreground">{user.email}</p>
      <Button variant="secondary" className="mt-3 w-full" onClick={signOut}>
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Not found
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        That page doesn&apos;t exist.{' '}
        <Link to="/" className="text-foreground underline underline-offset-4">
          Go to Today
        </Link>
      </p>
    </section>
  );
}
