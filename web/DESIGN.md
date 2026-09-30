# Web design tokens

Derived for Hireframe from `docs/DESIGN.md` ("Linear / Vercel tier": calm, dark-first, dense where it matters).
`docs/DESIGN.md` suggested pulling a DESIGN.md from styles.refero.design; its reuse terms aren't stated, so nothing is copied into this public repo. The tokens below are our own, in the same spirit.

Source of truth: `web/src/styles.css`. Components use Tailwind utilities mapped to these tokens (`bg-surface`, `text-muted-foreground`, …), never hex values.

## Colour
| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `background` | `#0b0c0e` | `#fafafb` | Page |
| `surface` | `#111214` | `#ffffff` | Sidebar, cards, tab bar |
| `surface-raised` | `#17181b` | `#f3f4f6` | Active nav, selected segment, secondary buttons |
| `border` | `#25272c` | `#e2e4e8` | Hairlines |
| `foreground` | `#e7e8eb` | `#15171c` | Primary text |
| `muted-foreground` | `#9da1ab` | `#585e6b` | Secondary text (≥ 4.5:1 on background) |
| `accent` / `ring` | `#8b93ff` | `#4b53d6` | Primary action, focus ring |
| `danger` | `#ff7b72` | `#c4262e` | Errors |
| `verdict-apply` | `#3fb950` | `#1a7f37` | Apply (always with label + icon) |
| `verdict-near-miss` | `#d29922` | `#9a6700` | Near miss |
| `verdict-wildcard` | `#a371f7` | `#8250df` | Wildcard |
| `verdict-skip` | `#8b949e` | `#6e7781` | Skip |

Theme: `<html data-theme>` is `dark` (default), `light`, or `system` (follows `prefers-color-scheme`). The choice is stored in `localStorage` when available.

## Type
- UI: Inter Variable. Numbers, IDs and labels: JetBrains Mono Variable, with tabular numerals for stats. Both are self-hosted via `@fontsource-variable/*` (no font CDN, so there's nothing to allow in the CSP).
- Page title `text-xl font-semibold tracking-tight`; section `text-sm font-medium`; body `text-sm`.

## Shape and spacing
- Radius: 6 / 8 / 12 px (`rounded-sm` / `md` / `lg`).
- Touch targets ≥ 44×44 px (`min-h-11`, `size-11`).
- Content max width `max-w-5xl`; page padding 16 px phone, 32 px desktop.

## Motion
150 ms `ease-out` colour transitions on interactive elements only. `prefers-reduced-motion` disables animation and transitions.
