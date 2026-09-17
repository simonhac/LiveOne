# `points.transform` — what it means, and why it is still read-time

Status: current as of 2026-09-18.

A point's `transform` column says how to read its stored values. Two values are live:

| value | meaning | applied where |
| --- | --- | --- |
| `'i'` | the column holds the VENDOR's sign, which is the inverse of canonical | every reader |
| `'d'` | the counter is served as DELTAS rather than absolute readings | the series builders |
| `null` / `'n'` | the column is already canonical | nowhere |

🛑 `'i'` and `'d'` are unrelated mechanisms that happen to share a column. `'d'` is **not** a sign
flip, and negating it would turn every energy counter in the fleet upside down.

Canonical, for the avoidance of doubt, is **`bidi.*` power positive = inflow/import** — see
[energy-flow-matrix.md](energy-flow-matrix.md) and [load-calcs.md](load-calcs.md). Sigenergy
normalises to it at ingest (`toWInverted`); Selectronic does not, and that is what `'i'` is for.

## Apply it through `canonicalValue()`

`lib/point/canonical-value.ts`. Every consumer of a stored value owes the same flip, and for over a
year one of them did not pay it:

- ✅ `lib/history/build-series.ts` — `/api/history`
- ✅ `lib/aggregation/flow-series.ts` — the flow matrix, via `applyPowerTransform`
- ✅ `lib/battery-provenance/load.ts` — the battery fold
- ✅ `lib/collectors/interval-comparison.ts` — the Go-usher trial comparison
- ✅ `app/api/admin/devices/[systemId]/point-readings/route.ts`
- ❌ → ✅ the KV latest-values cache (`lib/point/point-manager.ts`), fixed 2026-09-18

The symptom was not subtle once you looked for it: **`liveone device latest` and `liveone device
history` returned opposite signs for the same point at the same instant.** It cost an afternoon and
produced two confidently wrong conclusions about which way the data ran, because each read on its
own was internally plausible.

Those five ✅ entries still carry their own copies of `transform === "i" ? -v : v`. Converging them
onto `canonicalValue()` is worth doing when each is next touched; it was deliberately not done in
one sweep, because a same-day refactor of five read paths is a poor companion to a bug fix.

## Why the stored column was not migrated instead

The tidier end state is one convention in the store, normalised at ingest, with no reader flipping
anything. It was attempted twice and abandoned twice. Recording why, because the idea is attractive
and will come back:

**Attempt 1 — quiesce ingest, then rewrite.** Pause the `live` lane, drain it, treat everything
present as legacy, negate, clear the transform. Unsound: `queue pause` stops **dispatch, not
polling**. The collectors keep publishing, so messages produced before the cutover sit in the outbox
and land *after* the repair has finished validating. Racing it is not winnable either — the lane is
fleet-wide, and draining to zero then pausing still caught messages in flight, twice. Stopping the
poller instead would be worse than the bug: Selectronic is a live-poll vendor with no history
endpoint (`lib/vendors/sync-legs.ts` covers amber, sigenergy and openelectricity only), so the gap
could never be backfilled.

**Attempt 2 — classify by session rather than by clock.** Repair a row iff `session_id IS NULL` or
its session predates the cutover. The classification is genuinely correct: a session records when
*we polled*, so a pre-cutover message is identified however late it lands and whatever vendor
timestamp it carries — which is exactly what a `measurement_time` boundary cannot do. It was still
unsound, for a reason worth internalising:

> **Knowing which rows qualify does not ensure you ever process them.**

With ingest live, a late message inserts a row *behind* the repair's advancing cursor. The scan
never revisits it, the fixed `max(measurement_time)` excludes anything arriving later, and the
completion guard then locks out any further repair. Two further defects in the same family: the
pre-loaded session set misclassified sessions created *during* the run, and resumability was broken
because the writes commit per 500 rows while the checkpoint advanced per day.

**What a correct migration would need:** version-aware normalisation at the receiver, so late
old-decoder messages are corrected on arrival, coordinated with a genuinely idempotent historical
repair (assign from an immutable original→target record, never negate in place). That is a real
project against `/api/observations/receive` — the single writer of the serving store — to fix
something that is now consistent in six places out of six.

So the transform stays. It is documented debt, not an oversight.

## If you are adding a new consumer

Use `canonicalValue()`. Do not write your own `transform === "i"` check — that is precisely how six
consumers ended up with five conventions.

And note the census caveat: `area_bindings.transform` can override `points.transform`
(`lib/battery-provenance/load.ts`), so a sweep of `points.transform` alone does not tell you every
effective transform in the fleet.
