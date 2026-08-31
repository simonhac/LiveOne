# The session-response archive

Status: **current** — describes `sessions.response` as of 2026-09-01.

Every poll writes the vendor's **verbatim** response body to `sessions.response` (jsonb), keyed by
`device_rid` + `created_at` and indexed on both. Roughly a year of minutely/5-minutely payloads;
`sessions` is ~870k rows. `point_readings.session_id` FKs back to it, so any stored reading can be
traced to the payload it came from.

It is not a log. It is the only place the **raw upstream truth** survives, and this doc exists
because it is chronically under-used: as of writing, nothing reads it on a schedule.

## Why it is worth having

**Our stored readings cannot answer "was this absent, or genuinely zero?"** Parsers collapse the
distinction — Selectronic's `|| 0` idiom does it for `battery_soc`, `grid_w`, `fault_code` and every
energy total; Sigenergy's `pickNumber` did it via `Number()` until 2026-09-01. Once collapsed, the
information is gone from `point_readings` forever. It is still in the archive.

Worked examples, all of which settled a question nothing else could:

- **Daylesford `gen_status`** — the point read `0` in all 404k samples. The archive showed the field
  is present in every one of 374,338 responses with a **stable 22-key** item set, and `0` throughout
  a 10-hour generator run. Dead at source, not a driver bug — the inverter's generator demand is not
  observable through its API at all, which is why run tracking does not use it.
- **Sigenergy counter dropouts (2026-08-31)** — the live payload's `pvDayNrg` read 26.97 kWh
  straight through a window where the statistics endpoint reported `powerGeneration: 0`. That
  localised the fault to the statistics path and ruled out a meter reset. Nothing in our own store
  could have distinguished the two. See
  [../plans/sigenergy-counter-dropout-forensics.md](../plans/sigenergy-counter-dropout-forensics.md).
- **`pickNumber` blast radius (2026-09-01)** — a `jsonb_typeof` census over 3,000 responses proved
  every field the parser reads is a JSON number, so tightening it was provably a no-op — while
  showing that `onGrid` (boolean) and `greenSourceInfos` (array) sit right beside them.
- Tesla's point-metadata test fixtures and `lib/automations/progress.ts`'s dispensed-energy
  threshold were both derived from archived payloads (see their file headers).

## The two designed uses

1. **Replay-through-a-fixed-adapter.** When a parser is wrong, history can be rebuilt from the
   archive instead of being written off: `scripts/utils/rebuild-sigenergy-readings.ts` →
   `ReadingsDao.updateRawValues`. This is why `parseEnergyFlow` takes the FULL response body rather
   than an unwrapped one — so an archived row can be handed straight in and a future change to the
   field mapping can never leave replayed history disagreeing with live polls.
   ⚠️ It repairs **values**, not coverage: it does not invent rows, so gaps survive it untouched.
2. **Evidence.** The absent-vs-zero questions above.

## ⚠️ Its blind spot: batch and backfill paths archive a SUMMARY

The archive covers **poll** sessions. A batch job stores whatever its route puts in `response`, and
that is usually a result summary. `sigen-energy-backfill` sessions hold
`{days:[{date,intervalsFetched,readingsWritten,…}]}` — `pullEnergyDay` never persisted the vendor
body it had in hand.

That mattered: for the life of the Sigenergy integration the `statistics/energy` `itemList` carried
per-interval **power and SoC** (`pvTotalPower`, `loadPower`, `batSoc`, …) that nothing read, and an
entire derivation subsystem was built on the premise that no historical power existed. The archive
could not have caught it, because that payload was never archived. It was found by adding
`?raw=true` to the route and looking.

**So: do not read "it's in the archive" as "we would have noticed."** Check whether the path you
care about persists its payload at all.

## The question nobody asks: what do we archive and never read?

Both 2026-09-01 findings came from this shape of query. It is cheap, and it has paid out twice.

```sql
-- Every top-level key in a device's recent payloads, with type and range.
-- Compare against what the vendor's parser actually reads.
WITH recent AS (
  SELECT response->'data' AS body FROM sessions
  WHERE device_rid = 13 AND response ? 'data'
  ORDER BY created_at DESC LIMIT 500
)
SELECT kv.key, jsonb_typeof(kv.value) AS t,
       round(avg((kv.value#>>'{}')::numeric) FILTER (WHERE jsonb_typeof(kv.value)='number'), 2) AS avg
FROM recent, jsonb_each(recent.body) kv
GROUP BY 1,2 ORDER BY 1;
```

For Kutis that returns, among the fields the adapter reads, several it does not — most notably
**`pvDayNrg`**, a cumulative daily-generation counter present in every 5-minute payload and never
used. Its daily maxima are the metered totals exactly (2026-08-18 31.13, 08-19 10.59, 08-20 26.97),
so it is an **independent** cross-check on the statistics counters: on 2026-08-19 the flow matrix
was reporting 113.49 kWh of solar against a `pvDayNrg` of 10.59. A comparison against a field we
already store would have caught that months earlier. (`generatorPower`, `heatPumpPower`,
`thirdPvPower` are also unread but flat zero on this site — absent hardware, genuinely nothing.)

## Practical notes

- ⚠️ `jsonb_object_keys()` is **set-returning** — putting it in a SELECT list over many rows
  cross-products. Pin to a bounded set first (`WITH recent AS (… LIMIT n)`), as above.
- Filter by `device_rid` + `created_at` (both indexed) and never scan `sessions` blind — see the
  big-table warning in `CLAUDE.md`.
- A full-history `GROUP BY response->…` over ONE device runs fine as a one-off; set a
  `statement_timeout`.
- Payloads reach the archive through `transformForStorage` (`lib/json.ts`), which normalises
  `Date`/`CalendarDate`/`*TimeMs` fields — so a value's *type* is ours, its *presence* is theirs.
- Live equivalent, when history is not what you need: `POST /api/test-connection {"systemId":N}`
  (admin) returns `vendorResponse` from the adapter using stored credentials.
