import { Ellipsis, LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

import { Button } from '@/components/ui/button';
import { ToastHost } from '@/components/ui/toast-host';
import { cn } from '@/lib/utils';
import { ThemeSwitcher } from '@/theme/ThemeSwitcher';

import { NAV_ITEMS, type NavItem } from './nav';
import { useSession } from './session';

function SidebarLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) =>
        cn(
          'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150 ease-out',
          isActive
            ? 'bg-surface-raised font-medium text-foreground'
            : 'text-muted-foreground hover:bg-surface-raised hover:text-foreground',
        )
      }
    >
      <item.Icon aria-hidden="true" className="size-4" />
      {item.label}
    </NavLink>
  );
}

function TabLink({ path, label, Icon }: { path: string; label: string; Icon: NavItem['Icon'] }) {
  return (
    <NavLink
      to={path}
      end={path === '/'}
      className={({ isActive }) =>
        cn(
          'flex min-h-14 flex-col items-center justify-center gap-1 text-[11px]',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )
      }
    >
      <Icon aria-hidden="true" className="size-5" />
      {label}
    </NavLink>
  );
}

/** App shell (docs/DESIGN.md "Layout"): sidebar on desktop, bottom tab bar on phone. */
export function Shell() {
  const { user, signOut } = useSession();

  return (
    <div className="min-h-dvh bg-background text-foreground md:grid md:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-accent-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-surface p-3 md:flex">
        <p className="px-3 py-4 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Hireframe
        </p>
        <nav aria-label="Primary" className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <SidebarLink key={item.path} item={item} />
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t pt-3">
          <ThemeSwitcher />
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
              {user.email}
            </p>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </div>
      </aside>

      <main
        id="main"
        tabIndex={-1}
        className="min-w-0 px-4 pt-6 pb-24 outline-none md:px-8 md:pt-8 md:pb-8"
      >
        <Outlet />
      </main>

      <nav
        aria-label="Tabs"
        className="fixed inset-x-0 bottom-0 grid grid-cols-4 border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV_ITEMS.filter((item) => item.inTabBar).map((item) => (
          <TabLink key={item.path} path={item.path} label={item.label} Icon={item.Icon} />
        ))}
        <TabLink path="/more" label="More" Icon={Ellipsis} />
      </nav>
      <ToastHost />
    </div>
  );
}
