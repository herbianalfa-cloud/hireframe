import { Ellipsis, LogOut } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import { Button } from '@/components/ui/button';
import { PipelineBadge, pipelineLabel } from '@/features/pipeline/PipelineBadge';
import { useTodoCount } from '@/features/pipeline/useTodoCount';
import { whenUsable } from '@/lib/perf';
import { cn } from '@/lib/utils';
import type { TodoCount } from '@/services/pipeline-todo';
import { ThemeSwitcher } from '@/theme/ThemeSwitcher';

import { NAV_ITEMS, type NavItem } from './nav';
import { useSession } from './session';

const PIPELINE_PATH = '/pipeline';

/**
 * The pipeline count, read only once the app is usable: after Today marks `hf:usable`, or at the
 * first idle moment on any other route (M7 7D.4). Mounted once in the shell, so a route change
 * doesn't restart it.
 */
function useShellTodo(): TodoCount {
  const { pathname } = useLocation();
  const [usable, setUsable] = useState(false);
  const [startedOnToday] = useState(() => pathname === '/');
  useEffect(() => {
    let cancelled = false;
    void whenUsable(startedOnToday).then(() => {
      if (!cancelled) setUsable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [startedOnToday]);
  return useTodoCount(usable);
}

function SidebarLink({ item, todo }: { item: NavItem; todo: TodoCount }) {
  const isPipeline = item.path === PIPELINE_PATH;
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      {...(isPipeline ? { 'aria-label': pipelineLabel(item.label, todo) } : {})}
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
      {isPipeline ? (
        <span className="ml-auto">
          <PipelineBadge state={todo} />
        </span>
      ) : null}
    </NavLink>
  );
}

function TabLink({
  path,
  label,
  Icon,
  badge,
  ariaLabel,
}: {
  path: string;
  label: string;
  Icon: NavItem['Icon'];
  badge?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <NavLink
      to={path}
      end={path === '/'}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      className={({ isActive }) =>
        cn(
          'flex min-h-14 flex-col items-center justify-center gap-1 text-[11px]',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )
      }
    >
      <span className="relative">
        <Icon aria-hidden="true" className="size-5" />
        {badge ? <span className="absolute -top-2 left-3">{badge}</span> : null}
      </span>
      {label}
    </NavLink>
  );
}

/** App shell (docs/DESIGN.md "Layout"): sidebar on desktop, bottom tab bar on phone. */
export function Shell() {
  const { user, signOut } = useSession();
  const todo = useShellTodo();

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
            <SidebarLink key={item.path} item={item} todo={todo} />
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
        className="fixed inset-x-0 bottom-0 grid grid-cols-5 border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {NAV_ITEMS.filter((item) => item.inTabBar).map((item) => (
          <TabLink
            key={item.path}
            path={item.path}
            label={item.label}
            Icon={item.Icon}
            {...(item.path === PIPELINE_PATH
              ? {
                  badge: <PipelineBadge state={todo} />,
                  ariaLabel: pipelineLabel(item.label, todo),
                }
              : {})}
          />
        ))}
        <TabLink path="/more" label="More" Icon={Ellipsis} />
      </nav>
    </div>
  );
}
