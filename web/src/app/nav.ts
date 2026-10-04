import {
  Activity,
  BriefcaseBusiness,
  LayoutDashboard,
  Search,
  SlidersHorizontal,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  path: string;
  label: string;
  Icon: LucideIcon;
  /** Shown in the phone bottom tab bar; the rest live under "More". */
  inTabBar: boolean;
  empty: { title: string; body: string };
}

/** Screens from docs/PRD.md R7 / docs/DESIGN.md. Job detail opens over Today and Jobs (`?job=`). */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: '/',
    label: 'Today',
    Icon: LayoutDashboard,
    inTabBar: true,
    empty: {
      title: 'No scans yet',
      body: "Once scanning is live, today's Apply, Near miss and Wildcard jobs appear here with the key numbers.",
    },
  },
  {
    path: '/jobs',
    label: 'Jobs',
    Icon: BriefcaseBusiness,
    inTabBar: true,
    empty: {
      title: 'No jobs yet',
      body: 'Every scanned job appears here with its verdict, scores and the stage that decided it.',
    },
  },
  {
    path: '/lookup',
    label: 'Lookup',
    Icon: Search,
    inTabBar: true,
    empty: {
      title: 'Look up a job link',
      body: "Paste any job URL to see whether it's been seen, and what the verdict was. Coming soon.",
    },
  },
  {
    path: '/profile',
    label: 'Profile',
    Icon: UserRound,
    inTabBar: false,
    empty: {
      title: 'No profile yet',
      body: 'Upload your master CV to build the fact library that every verdict and tailored CV draws on.',
    },
  },
  {
    path: '/criteria',
    label: 'Criteria',
    Icon: SlidersHorizontal,
    inTabBar: false,
    empty: {
      title: 'No criteria yet',
      body: 'Target lanes, exclusions, locations and thresholds the funnel judges jobs against.',
    },
  },
  {
    path: '/system',
    label: 'System',
    Icon: Activity,
    inTabBar: false,
    empty: {
      title: 'No runs yet',
      body: 'Run history, source health, errors and spend against the monthly cap.',
    },
  },
];
