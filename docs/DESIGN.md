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
- Desktop: left sidebar (Today, Jobs, Pipeline, Lookup, Profile, Criteria, System), content, right drawer for Job detail.
- Phone: bottom tab bar of five columns (Today, Jobs, Pipeline, Lookup, More); Job detail as full-screen sheet. The Pipeline item carries a count badge for what's waiting on you: a small skeleton until it is read, a number from 1 ("50+" at the read limit), nothing at 0, and "–" if the read failed. The link's own name carries it ("Pipeline, 3 to do"), the badge is decorative, and on the tab bar it sits over the icon so it can't widen a column.
- Command palette (⌘K): jump to job, paste link to look up, "add fact", "scan now".

## Key screens
- **Today:** summary bar → Apply list → Near misses → Wildcards → Added by you. The bar shows a skeleton row until the Apply list is in; then its row appears at once, each count with its own skeleton that fails alone (last run and spend settle alone too): open Apply, near miss and wildcard counts (each a link to Jobs, with the verdict icon and colour), applied this week vs target, last run (time and status in words, "Timed out" for a killed run), next run (07:30 or 17:30 on weekdays) and a compact spend chip linking to System (amber with a warning icon from 80%). Every item has a label and a number or icon, never colour alone. **Things to do** (applications that need your input or are ready to send) links to Pipeline, with its own skeleton and a dash and "unavailable" when it fails alone. Each row: company logo/initial, title, location, age, fit/luck chips, one-line reason.
- **Job detail:** verdict + reason at top; requirements table (met/partial/missing with fact links); gaps; talking points; actions bar (Open posting, Apply, Save, Skip, 👍/👎) and a separate **Start application** control that shows the stage and a link to Pipeline once an application exists. Apply is disabled, with the reason, while the CV is being written.
- **Pipeline:** a count per stage (Chosen, Needs your input, Generating, Ready to send, Applied this week), then a section per stage, each with its own skeleton, error and empty state. Each stage has a colour token, a label and an icon (never colour alone): `--stage-chosen`, `--stage-input`, `--stage-generating`, `--stage-ready`, `--stage-applied` in `styles.css`, with `text-stage-*` utilities, for dark and light.
  - *Needs your input:* the requirement as text with its level and match, an answer box (≤ 2,000 characters) with Answer and Skip, and Skip all when two or more are open; answered and skipped ones stay as read-only lines.
  - *Generating:* "Usually within 15 minutes", and the fact-check reasons in words after an invalid draft.
  - *Ready to send:* four downloads (CV and cover note, .pdf and .docx), the version from the second on, Regenerate with notes, Withdraw.
  - *Chosen:* the blocked reason in words, Retry, and Add CV header when that is the reason.
  - *Applied:* read-only, newest marked first, with the date it was marked applied. Undo is on the job.
- **System:** run history, source health, spend meter vs cap, errors.

## Quality bar
Empty, loading (skeletons), and error states designed for every screen. Keyboard: `j/k` move, `a` applied, `s` skip, `o` open. Lighthouse a11y ≥ 95, WCAG 2.1 AA, 44×44 px touch targets.

