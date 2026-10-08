# M6 PR 6B, session 2 (web): what you need to know

- **Callable contract:** `LookupInputSchema`, the three result schemas, `LookupOutcomeSchema` and `LOOKUP_LIMITS` are in `packages/shared/src/lookup.ts`. Outcomes are `seen | judged | skipped | needs_description | queued | review | not_found | invalid`. A `busy` add returns `{ status: 'busy', retryAfterSeconds }` as a value, not an error. The client must never retry.
- **Browser helpers:** `parseLookupInput`, `parseResultsPage(text, links)` and `parseAtsUrl` are pure and ready. A pasted URL reduces to the stored form, `https://www.linkedin.com/jobs/view/{id}` for any LinkedIn view link.
- **Match queries:** `jobsByKeysSpec` is server-side and covers `lookupKeysSpec`. The emulator R8 test already shows `array-contains-any` on `keys` and `url ==` canonical finding an alert job by every URL form. The web specs and their `indexes.test.ts` case still need writing. I deliberately did not touch `web/`.
- **Results-page format:** my parser and the fixture (`fixtures/results-page.ts`) follow an assumed LinkedIn copy format (title shown twice, company, location with an optional `(Hybrid)`, badges, age). Refresh it from a real paste with fake values, as the plan says.
- **IDs come from anchors only:** a LinkedIn ID is read only from `{href, text}` pairs, which `pasteAnchors.ts` must produce with `DOMParser` and never insert into the page. The server pairs titles with unused `/jobs/view/` anchors in page order.
- **Waiting list and sheet:** `needs_description` jobs are `next == 'description'`, from Lookup or from alert ingest. `describe` refuses with `{ status: 'refused' }` if the job moved on.
- **UI labels needed:** `posted_estimated` (flag text already added), `addedAt` for the Added by you list, `sources[].searchLink` for the "Search link" label, and the new flags and states.
- **Bundle:** shared now exports `lookup.ts`, but initial JS did not grow (292.9 kB). Keep the Lookup code in the lazy chunk.
