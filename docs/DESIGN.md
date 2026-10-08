# Design

Goal: feels like a paid product (Linear / Vercel / Attio tier). Calm, dense where it matters, fast.

## Foundations
- **Components:** shadcn/ui (Radix) only; add from 21st.dev/Magic UI only if it earns its place.
- **Style reference:** pull one DESIGN.md from styles.refero.design (Linear or Vercel) into `web/DESIGN.md` at M1 and derive tokens from it.
- **Theme:** dark default, light toggle, `prefers-color-scheme` respected. Colours as CSS tokens on `:root`; no hard-coded hex in components.
- **Type:** Inter (UI) + JetBrains Mono (numbers, IDs). Tabular numerals in all stats.
- **Semantic colour:** Apply = green, Near miss = amber, Wildcard = violet, Skip = neutral grey. Never colour alone — every verdict has a label + icon.
- **Motion:** 150–200 ms, ease-out; only for state changes (drawer, list reorder). Respect `prefers-reduced-motion`.
- **Density:** comfortable on phone, compact option on desktop.

## Layout
- Desktop: left sidebar (Today, Jobs, Lookup, Profile, Criteria, System), content, right drawer for Job detail.
- Phone: bottom tab bar (Today, Jobs, Lookup, More); Job detail as full-screen sheet.
- Command palette (⌘K): jump to job, paste link to look up, "add fact", "scan now".

## Key screens
- **Today:** summary bar → Apply list → Near misses → Wildcards → Added by you. The bar shows a skeleton row until the Apply list is in, then: open Apply, near miss and wildcard counts (each a link to Jobs, with the verdict icon and colour), applied this week vs target, last run (time and status in words, "Timed out" for a killed run), next run (07:30 or 17:30 on weekdays) and a compact spend chip linking to System (amber with a warning icon from 80%). Every item has a label and a number or icon, never colour alone. A "Things to do" slot arrives with the pipeline. Each row: company logo/initial, title, location, age, fit/luck chips, one-line reason.
- **Job detail:** verdict + reason at top; requirements table (met/partial/missing with fact links); gaps; talking points; actions bar (Open posting, Applied, Skip, 👍/👎, Generate CV).
- **System:** run history, source health, spend meter vs cap, errors.

## Quality bar
Empty, loading (skeletons), and error states designed for every screen. Keyboard: `j/k` move, `a` applied, `s` skip, `o` open. Lighthouse a11y ≥ 95, WCAG 2.1 AA, 44×44 px touch targets.

