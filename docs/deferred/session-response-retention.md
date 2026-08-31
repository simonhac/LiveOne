# Retention for `sessions.response`

> **Status:** deferred — measured 2026-09-01, no decision taken. Numbers are from the `liveone-dev`
> mirror, which carries the full session history (2025-11-04 → 2026-08-31, 1.23M rows), so the
> proportions should transfer to prod even though absolute sizes will differ.

`sessions` is **1367 MB of a 5581 MB database — 24.5%**, third behind `point_readings` (2446 MB) and
`point_readings_agg_5m` (1643 MB). Two facts drive the arithmetic: the archived payload is **~90 % of
every row** (avg 1058–1243 B of `response` against ~91–118 B for all other columns, and at ~1.1 KB it
sits inline in the heap rather than in TOAST — hence 1153 MB heap and only 119 MB toast), and
**69.2 % of rows are older than three months** (849k of 1.23M). So nulling `response` on rows older
than three months while keeping the rows would reclaim **~751 MB, 13.5 % of the database**; deleting
those sessions outright would reclaim **~894 MB, 16.0 %**. The gap between the two is only ~143 MB —
**2.6 % of the database** — because once the payload is gone the session row itself costs almost
nothing. Nulling therefore buys ~84 % of the benefit of deleting while preserving the metadata the
operational tooling actually reads: timing, `successful`, `error`, `num_rows` and `session_label`,
used by `scripts/utils/poll-cadence.ts`, the observations monitor and the admin session viewer.

Two things should decide it. **Deleting is blocked by a foreign key**: `point_readings.session_id`
references `sessions` with `ON DELETE NO ACTION`, so a four-month-old session cannot be deleted while
any reading still points at it — and readings are retained far longer. Deletion is therefore a schema
change first (drop the FK, or move it to `ON DELETE SET NULL`) and it severs every reading's
traceability back to the payload it came from; nulling touches neither. **And neither option shrinks
the file on its own** — both leave dead tuples, so space is reclaimed for reuse rather than returned
to the OS without `VACUUM FULL` (an `ACCESS EXCLUSIVE` lock) or `pg_repack`; the honest framing is
"stops the table growing", not "disk drops 750 MB tomorrow". Against that, weigh what the archive is
for (see [../architecture/session-response-archive.md](../architecture/session-response-archive.md)):
three months is short for absent-vs-zero forensics and for replaying history through a fixed adapter
— the Daylesford `gen_status` finding spanned 374k responses — so a six-month window would cost
roughly half the saving and keep the capability materially intact. Recommended shape if this is
taken up: **null `response` beyond six months, keep the rows, leave the FK alone.**
