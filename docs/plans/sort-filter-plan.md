# Sort and filter on Today and Jobs: plan (branch `feat/sort-filter`)

> Approved 2026-10-05. Build on `feat/sort-filter`; this file is the spec.

## Context
Today's three lists and the Jobs screen only show jobs newest-judged first (`judgedAt desc`). The owner wants to sort by score, find near misses by the kind of gap, and see one lane at a time. This is a small UI PR: no funnel changes, no schema changes, no new Firestore query shapes, initial JS stays inside the budget, and Today's first load is no slower.

## What exists today
- **Today** (`web/src/features/today/TodayPage.tsx`): one live query per list (`todayListSpec`, `web/src/services/dashboard.ts:83`) for open jobs of one verdict, `judgedAt desc`, `limit(TODAY_LIST_SIZE = 10)`. `hf:usable` fires once the tiles and the Apply list are filled.
- **Jobs** (`web/src/features/jobs/JobsPage.tsx`, `hooks.ts:useJobsList`, `services/jobs.ts:loadJobsPage`): `jobFilterSpec` (verdict, status or needs-review) with `judgedAt desc`, pages of 25 using a `startAfter` cursor and a **Load more** button. Filters are kept in the URL.
- **Current default sort everywhere: Newest** (`judgedAt desc`). No other sort exists.
- Fields (`packages/shared/src/funnel.ts`): `fitScore`, `luckScore` (0–10, optional), `gaps: {type, text}[]` with `GAP_TYPES = tool | sector | domain | seniority | hard-blocker`, and lane in `triage.lane` (`primary | secondary | opportunistic | wildcard | none`). Every list row already loads all of these, because `readJob` parses the full `JobSchema`.
- Today and Jobs are lazy routes (`web/src/app/App.tsx`), so their chunks don't count towards the 300 kB initial budget (`scripts/check-bundle.ts`).

## Decisions

### Browser or Firestore? Everything runs in the browser, with no new query and no new index.
| Feature | Where | Why |
|---|---|---|
| Sort: Best overall (fit + luck) | Browser | Firestore can only order by a stored field. Storing `fit + luck` would be a schema change. |
| Sort: Fit, Luck | Browser | `orderBy fitScore` would need a new composite index for every verdict × status combination (about 50 per sort), and Best overall still couldn't be done there. Keeping all four sorts in one place is simpler. |
| Sort: Newest | Firestore (unchanged) | This is the existing `judgedAt desc` query. |
| Near-miss gap filter | Browser | `gaps` is an array of objects. `array-contains` needs an exact `{type, text}` match, so Firestore can't query it. |
| Lane filter | Browser | `where('triage.lane', '==')` would need composite indexes for every combination with verdict, status and judgedAt, which is too many for a small PR. |

The query specs don't change (`limit` isn't part of a spec), so `indexes.test.ts` already covers every query this PR runs. I'll add one assertion that the full read uses `jobFilterSpec(filters)` unchanged.

### Jobs and "Load more": how sorting stays correct across pages
Sorting each page of 25 on its own would be wrong: page 2 can hold a better job than anything on page 1. So:
- **Newest with no lane or gap filter:** keeps the current cursor paging and **Load more**, unchanged.
- **Any other sort, or a lane or gap filter:** the hook switches to a **full read**. It runs one read with the same spec, `judgedAt desc`, and `limit(JOBS_SORT_CAP = 300)`, then filters and sorts the whole set in the browser and shows 25 at a time. The button becomes **Show more**, which reveals rows already in memory, with no further reads. With the whole set in memory, the order can't break at a page boundary.
- If the read returns exactly 300 rows, a note says *"Sorted among the newest 300 matching jobs."* That way a capped result is never presented as complete. The cap goes in a named constant in `services/jobs.ts`, next to `JOBS_PAGE_SIZE`.
- `patch` (optimistic actions) still updates the loaded array. The sorted and filtered view is derived with `useMemo`, so an action re-sorts in place without a reload (ADR-041 is unchanged).
- Cost: at most 300 document reads when you change the sort. That's fine for one user. Load time is about one larger page.

### Today: sort the loaded rows; first load is untouched
- Each list sorts the 10 rows it already has. Same query, same `limit(10)`, no extra reads. Sorting 10 rows takes microseconds, so `hf:usable` doesn't move.
- **Limitation:** "Best overall" on Apply ranks the **newest 10 open** Apply jobs. If more than 10 are open, an older, better job can be missing from the list. The footer says so: when the list is full, *"Sorted among the newest 10. See all apply jobs by best overall →"* links to `/jobs?verdict=apply&status=new&sort=best`, which is exact up to 300. Reading more rows on Today would fix this but slow the first load, which the brief rules out. (Parked as an option; see below.)
- **Defaults:** Apply → **Best overall** (as asked). Near misses, Wildcards and Jobs → **keep Newest**. Near misses and wildcards are review queues where staleness matters. Jobs is the archive, and Newest is its only sort that pages from Firestore without a full read.
- A sort you pick on Today is remembered per list in `localStorage` (`hf:today-sort:<list>`, every read and write in try/catch, falling back to the default). On Jobs, sort, lane and gap go in the URL like the existing filters (`?sort=best&lane=primary&gap=tool`). Invalid values fall back to the defaults.

### Near misses: gap filter
- Options: **Any / Tool / Domain / Seniority / Tool only**. Tool, Domain and Seniority match a job with at least one gap of that type. **Tool only** matches a job with at least one gap where *every* gap is `tool`: the near miss most worth applying to. A job with no gaps never matches a gap option. (`sector` and `hard-blocker` also exist. I'm not adding them without asking; adding one later is a one-line change.)
- **Today:** a "Gap" select in the Near misses header, filtering the 10 loaded rows. The heading shows the count, e.g. "3 of 10". When the list is full, the footer link carries `&gap=tool`.
- **Jobs:** the Gap select appears only when Verdict = Near miss. Changing the verdict clears `gap`.

### Lane filter
- **Jobs:** a "Lane" select: All / Primary / Secondary / Opportunistic, matching `job.triage?.lane`. Jobs without triage data (the older M3 jobs) only show under All.
- **Today: not added.** Filtering 10 rows by lane hides more than it shows, and a fourth control in every section header makes Today busier. Jobs is where you'd do this. Say if you want it anyway: it would be one page-level select over all three lists.
- Like Gap, Lane and a non-Newest sort are disabled while **Needs review** is on, matching how Verdict and Status already behave (ADR-040).

## Implementation

1. **Pure functions:** new `web/src/features/jobs/sort.ts`
   - `JOB_SORTS = ['best', 'fit', 'luck', 'newest'] as const`, `SORT_LABELS`, and `isJobSort()`.
   - `sortJobs(views, sort): JobView[]`. Stable. Best = `fit + luck` descending, then fit, then `judgedAt` descending, then id. Fit and Luck use the other score as the tiebreak, then `judgedAt`. Rows without scores go last. Newest = `judgedAt` descending.
   - `filterJobs(views, { lane?, gap? })`. `LANE_FILTERS` is a typed subset of `TRIAGE_LANES`. `GAP_FILTERS` is `tool | domain | seniority` (a typed subset of `GAP_TYPES`) plus `tool-only`. All come from `@hireframe/shared`, so no new literals.
   - About 1 kB, in the lazy Today/Jobs chunk.
2. **Service:** `services/jobs.ts`
   - `loadJobsWindow(filters)` → `{ jobs, invalid, capped }`, using `jobFilterSpec(filters)` with `limit(JOBS_SORT_CAP)`, the same timeout, retry and logging as `loadJobsPage`.
3. **Hook:** `features/jobs/hooks.ts`
   - `useJobsList(filters, { full })`. `full` is added to `sig`. When it's true, the hook calls `loadJobsWindow` and exposes `capped`; `loadMore` is unused.
   - New `useSortedJobs(jobs, sort, filter, pageSize?)` with `useMemo`, plus a `shown` count for Show more.
4. **UI**
   - **`JobsPage.tsx`:** Sort, Lane and Gap selects (native `<select>` with `SELECT_CLASS`, inside `<label>`), wired to URL params. Clear filters also clears lane and gap but keeps sort. The empty state counts the new filters as filters. Add the capped note, and Show more vs Load more.
   - **`TodayPage.tsx`:** small sort select in each `TodaySection` header (gap select too for near misses). The visible label is "Sort"; the list name is in `sr-only` text so the three controls have distinct names. Update the footer copy and carry the sort and gap in the link.
   - Shared `SortSelect` (and `FilterSelect`) component in `features/jobs/`, so Today and Jobs use the same markup.
   - The `j`/`k` keys and focus handover in `JobList` work on DOM order, which follows the sorted order. No change needed there.
5. **Docs**
   - **ADR-044:** sorting and lane/gap filtering are client-side, with the full-read cap. No stored combined score, because that would be a schema change. This states the cap and the Today limitation. PR B's reserved ADR-044 is already renumbered to ADR-045 (funnel-intake plan and ADR-043), because this PR merges first.
   - Update `CHANGELOG.md`.
   - **ROADMAP parking lot:** age/expiry chip on rows; hide rated jobs; bulk skip; a larger Today read for an exact "Best overall" (only if `hf:usable` has room); `sector`/`hard-blocker` in the gap filter; a lane filter on Today.
   - The parked "remove the three `review.stage` composites when the Jobs filters next change" item is triggered in principle. I'm leaving it parked: this PR adds no query shapes, and an index removal doesn't belong in a UI PR. Tell me if you'd rather do it here.

## Tests
- `sort.test.ts`: each sort's order, tiebreaks, missing scores last, stability, and lane/gap filtering, all on fake fixtures from `features/jobs/fixtures.ts`. Tool only rows:
  - only tool gaps → match
  - tool + domain → no match
  - no gaps → no match
  - only seniority → no match
  - `gaps` absent → no match
- `JobsPage.test.tsx`:
  - URL ↔ selects.
  - Switching to Best runs a full read, and the order is correct across Show more.
  - Capped note at 300.
  - Gap select appears only for near misses.
  - Needs review disables the new controls.
  - Newest still uses Load more.
- `TodayPage.test.tsx`:
  - Apply defaults to Best.
  - Near misses and Wildcards default to Newest.
  - Choice remembered, and still works when `localStorage` throws.
  - Gap filter count.
  - Footer link carries the params.
- `indexes.test.ts`: assert the full read uses `jobFilterSpec` unchanged. The existing combinations still pass.

## Verification
- `npm run check` (lint, typecheck, unit tests, PII scan, eval replay) clean.
- `npm run build && npm run check:bundle`: initial JS is unchanged, about 7 kB spare. Record the Today and Jobs chunk sizes before and after in the PR.
- `npm run dev` with seeded jobs. Check:
  - Every sort and filter, by keyboard only (Tab to the selects, arrow keys to choose, `j`/`k`/`a`/`s`/`o` on the sorted rows).
  - Light and dark themes.
  - Phone width: the controls wrap and stay 44 px tall.
- `hf:usable`: median of 3 repeat visits (Fast 4G, 4× CPU) before and after. It must stay within noise of today's number. No new reads on Today.
- Lighthouse accessibility on Today and Jobs stays at 100.
- Then commits (`feat:`, `test:`, `docs:`), and one PR from `feat/sort-filter` off `main`.
