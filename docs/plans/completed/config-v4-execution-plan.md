# Config v4 — the completed record

> **Status: COMPLETE. Started 2026-07-22, finished 2026-08-01.** Fifteen phases (0–14), 26 migrations
> (`0030` → `0055`), ten days. Prod and `liveone-dev` are both on the v4 shape with no migration debt.
>
> This file is the **record**, not a plan — there is nothing left to execute. It exists so that in a
> year someone can answer _why does the system look like this_: what was done, what it cost, what was
> decided and why, and which pieces of apparent legacy are sanctioned shims rather than debt.
>
> The **rationale** is [config-v4-clean-sheet.md](config-v4-clean-sheet.md), which remains the canonical
> design doc — read it for the model itself. The **invariants that outlive the migration** were folded
> into [../architecture/data-model.md](../../architecture/data-model.md) — the seam rule, the TypeID
> scheme, eager areas, fixed-offset days, the v4 document model and its security invariant, and the
> permanent-shim list — with the areas/dashboards model itself in
> [../architecture/areas-and-dashboards.md](../../architecture/areas-and-dashboards.md). This file does not
> restate them.
>
> The per-phase narrative docs (phase-7 rehearsal harness, phase-8 cutover, the phase-14 per-PR brief)
> were deleted at closeout. Git is the archive, and the PR bodies carry the measurements.

## 1. What it was

Before config-v4 the config layer had accreted three overlapping identity schemes and two dashboard
shapes. A "system" was simultaneously a vendor connection, an addressing handle, a timezone, and a
dashboard subject; a point was addressed by `"systemId.pointIndex"`; a multi-device view was
_synthesized_ at request time into a device-shaped object with a fake `vendor_type = 'area'`; and a
dashboard existed as both a v3 `descriptor` and a v4 `doc`, with an adapter and a rewriter between them.

The clean sheet replaced that with three layers and one identity space:

- **physical** — `devices` / `points`, keyed by UUIDv7, with an internal integer `rid` for the hot path
- **semantic** — `areas` / `area_members` / `area_bindings` / `derivations`
- **presentation** — `dashboards`, a recursive node-tree `doc`

Nothing about the _data_ pipeline changed. The readings tables, the outbox, the receiver and the
aggregation ladder were re-keyed but not re-designed.

## 2. What it cost

Measured as a two-point `git diff --numstat` between **`941c8a76`** (2026-07-22, the commit immediately
before the epic's first) and **`a5c77d2f`** (2026-08-01, stage 21), bucketed by path:

| bucket                                  | +added      | −removed   | net          | files   |
| --------------------------------------- | ----------- | ---------- | ------------ | ------- |
| source                                  | 32,768      | 16,716     | **+16,052**  | 498     |
| tests                                   | 16,209      | 1,957      | **+14,252**  | 119     |
| docs                                    | 5,228       | 1,308      | +3,920       | 28      |
| migrations                              | 3,203       | 1          | +3,202       | 27      |
| generated (drizzle snapshots, lockfile) | 84,336      | 4          | +84,332      | 27      |
| **TOTAL**                               | **141,744** | **19,986** | **+121,758** | **699** |

🛑 **Read the caveats before quoting any of this.**

- **A two-point diff measures everything that landed between the two commits.** It cannot attribute
  churn to an epic, and no commit-count ratio makes it able to. **These totals are an upper bound on
  config-v4's footprint, not a measurement of it.** Of the 118 commits in the range, **89 are
  unambiguously config-v4** (85 say so in the subject; four more — the Phase 3 readings-DAO drain, the
  Phase 12 device-create fix, and two docs commits — do not) and up to **94** counting borderline cases
  such as the `?migrations=1` health probe built to gate every apply. The rest is unrelated feature work
  (Sankey, Sigenergy, tile styling, preview CI). A defensible epic-only line count would require
  per-commit attribution; **it was not done, and it should not be estimated.**
- **The `generated` bucket is 60% of the raw added total** and is almost entirely drizzle snapshot JSON —
  one machine-written file per migration. Quoting 141,744 without saying so is misleading.
- **Tests grew +14,252 net across 119 files, against a source net of +16,052 across 498.** Roughly as
  much test code was written as production code. That is the most interesting number here, and it is not
  an accident: nearly every phase's proof was an executable gate (a migration `DO` block, a negative
  control, a prop-equivalence golden) rather than a review claim.

The `source` figure understates the demolition, because it nets deletions against additions inside one
bucket. Deleted outright over the epic: three registry tables (`systems`, `point_info`,
`polling_status`), two run-tracking tables, the `_old` hot tables (~4.2 GB per environment), the
`SystemsManager`, the dark mirror, the v3 dashboard island, the v3→v4 rewriter and the v4→v3 adapter,
28 legacy route handlers across 15 route files, and `scripts/config-v4/` in its entirety.

## 3. The phases

| Phase                       | What landed                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–1 Governance + `lib/ids/` | Prefixes locked; client-safe TypeID codec, six branded codecs (cross-entity misuse is a compile error).                                                                                                                                                                                                                |
| 2 Point identity            | **0030**: `point_uid` NOT NULL, global `point_rid_seq` + `point_info.rid` backfilled deterministically.                                                                                                                                                                                                                |
| 3 Readings DAO seam         | The highest-leverage strangler, no migration. 31 modules behind `ReadingsDao` over PRs A–L.                                                                                                                                                                                                                            |
| 4–6 Additive v4 + `/api/v4` | **0032–0034**: dark columns, `derivations`, `derived_intervals`, `dashboard_revisions`, `legacy_handles`; the v4 doc model, rewriter and adapter; dashboards CRUD.                                                                                                                                                     |
| 7–8 **The cutover**         | **0035**, 2026-07-26. Planning ran as a 14-agent workflow that found 7 defects in a "23/23 green" transform. Dev cut over first as a dress rehearsal, prod the same day; **pollers never stopped** — only materialization paused.                                                                                      |
| 9 Post-cutover fixes        | prod→dev sync FK break (post-cutover `dashboards.id` is minted per environment; only `legacy_id` is stable cross-env) + full `ar_` uniformity across `/api/areas/*`.                                                                                                                                                   |
| 10 Scaffolding demolition   | **0036–0039**: `_old` hot tables + `backfill_progress` dropped, hot index names canonical, cutover pause disarmed, `db:pg:generate` trustworthy again.                                                                                                                                                                 |
| 11 Derivations              | **0040–0041**: run-tracking + HWS collapsed onto `derivations`; `device_trackers` / `device_run_periods` dropped.                                                                                                                                                                                                      |
| 12 **Registry cutover**     | **0042–0051**, 2026-07-30. `devices`/`points` are the only registry; `SystemsManager`, the dark mirror and `scripts/config-v4/` deleted; **`systems`, `point_info`, `polling_status` dropped**; `sessions`/`observations_outbox` on `device_rid`. Terminal window: ~11 min pause→drained, no gap, no DLQ, no rollback. |
| 13 **Kill the handle**      | **0052**, 2026-07-31, seven PRs. Area-native serving + `ar_`/`dv_` on the wire; synthesis deleted; KV keyspace TypeID-keyed; `systems`→`devices` across 315 files; ~48 readers onto `legacy_handles`; **`areas.legacy_system_id` dropped**. No window needed.                                                          |
| 14 **One dashboard shape**  | **0053–0055**, 2026-08-01, 22 stages. Card plugins v4-native behind one `CARD_RENDERERS`; both legacy route trees deleted; **`dashboards.descriptor` dropped**; the last raw-uuid wire leak closed; run statistics carry their unit.                                                                                   |

### Phase 14 in more detail, because it was the largest

Twenty-two stages ran as parallel worktrees against one orchestrator, in seven waves. What it did:

- **Exercised `/api/v4` for the first time.** The whole surface had been built dark — zero `fetch()`
  callers and zero route tests. Driving all 12 handlers once found **four defects**, including a
  `23505` predicate that had never matched (see §7).
- **Built the 10 missing v4 mutation handlers** (7 area + 5 sharing legacy handlers collapse to 10,
  because `POST`+`DELETE …/devices` became one `PUT …/members` and the same for `…/grants`), then
  **ported the 4 orphan reads** and **deleted all 28 legacy handlers across 15 route files**.
- **Made the card plugins v4-native.** `CardRenderProps` went from `{card, section, handle}` to
  `{node, context, handle, deviceSystemId}`; the split card (10) and tile (9) registries became one
  `CARD_RENDERERS` (`components/dashboard/registry.tsx`); `v4-adapt.ts` and the entire
  `lib/dashboard/{v3,cards,v3-to-v4}.ts` island were deleted.
- **Dropped `dashboards.descriptor`** (0054), ending the dual shape.
- **Closed the last raw-uuid leak on the wire** (0053) — helper devices carried
  `vendor_site_id = 'helper:area:<raw uuid>'`, emitted verbatim by `/api/data` and reachable
  anonymously through a share token. Rewritten in place to `helper:area:ar_…`.
- **Shipped the two queued cards** — `daily-stripe` and `heatmap` — now that the plugin surface was
  v4-native.
- **Made run statistics signal-neutral** (0055), retiring the `detector_version` gate that had been
  suppressing `avgSignal` for rows whose units predate the DSE re-point.

## 4. What survives, and where

**The invariants and locked decisions are in [../architecture/data-model.md](../../architecture/data-model.md)** —
the seam rule, the TypeID scheme, eager areas, fixed-offset days, the v4 document model and its security
invariant, and the permanent-shim list. They were moved there deliberately: they are properties of the
system now, not of the migration that produced them, and nobody reads a plan doc to learn how the system
works.

**Permanent shims — sanctioned, not debt.** Enumerated in `data-model.md`; the short version is
`legacy_handles`, `dashboards.legacy_id`, the `?systemId=N` alias, slug URLs, share-token phrases,
`lib/ids/`, the registry cache, and two standing verification scripts. Do not "clean these up".

**Shims with an expiry** — the `/api/system*` → `/api/device*` rewrites and the one-shot KV
integer-key sweeper — **all expired and were deleted in Phase 14.** Nothing remains on that list.

## 5. Decisions worth understanding a year from now

Each of these is a place where the obvious choice was not taken, and the reason is not recoverable from
the code.

- **Adapter over rewrite for the render window.** The card plugins were ported behind a still-present
  v4→v3 adapter and the adapter removed last, so each plugin was independently revertible. It cost one
  extra shape and paid for itself. ⚠️ **But an adapter can silently relax an invariant**: this one had
  been handing `battery-provenance-history` a **raw area uuid** where the card's own docstring asked for
  an `ar_`, because the synthesised v3 section carried the raw form. Nobody noticed until the adapter
  was deleted and the card had to read `context.area` instead. _An adapter's job is to hide a
  difference; that is also its failure mode._
- **Eager areas (Option A) — areas-of-one are kept forever.** Deleting them was the tidier model and was
  rejected: `flow_attr_1d` and `battery_provenance_daily` are uuid-keyed by area, so deleting an
  area-of-one destroys history. They are filtered out of the picker at render time instead. This
  abandoned an earlier approved plan to retire implied areas.
- **Accept a short outage rather than build expand/contract machinery.** Dropping `descriptor` is
  hard-coupled to the code that stops writing it — deploy-then-apply gives `23502`, apply-then-deploy
  gives `42703` — and **no ordering has a zero window.** Both break exactly one operation (creating a
  dashboard); reads, doc `PUT`s and ingest are untouched. The window was accepted, per the standing
  "Simon is the sole user" rule. 🛑 **On a system with more than one user this shape would need the
  expand step**, and that is recorded in the migration header.
- **The `/api/system*` compat rewrites were retired early, on purpose.** They existed only to cover the
  stale-browser-bundle window after a route rename. The calendar gate was waived because **LiveOne has
  no API consumers other than its own front end**, so the entire exposure is an already-open tab that
  404s until reload. Do not re-litigate.
- **Migration numbers are assigned at dispatch, not reserved per purpose.** Reserving "0053 = the
  descriptor drop" was wrong: drizzle's journal is a _sequential index_, so whichever migration lands
  first must take the lowest free number, and parallel stages do not land in plan order. Reserving by
  purpose would have left a journal gap.
- **One registry, but a discriminated plugin union — not unified props.** A tile is _data-driven_ (the
  host fetches `/api/data` and hands it `latest`, from which the tile also answers `isAvailable`); a card
  is _document-driven_ (handed its node and context, fetches its own). Unifying them has only two shapes
  and both are worse: a union would fire a `/api/data` fetch for **every card node** — a real behaviour
  change smuggled in under a refactor — and an intersection does not exist, because `isAvailable` has
  nowhere to live. So `CARD_RENDERERS` is `TilePlugin | CardPlugin`, discriminated by `kind`, with a
  `satisfies` gate that is total _and_ per-key correct.
- **v3 chart ids were deliberately not carried into the v4 doc.** §8.2 says node ids are server-assigned
  `n_…`; carrying the v3 `chart:lines` id would also have broken the seed-builder equivalence proof.
  React keys became positional rather than semantic — which v3 already was for every non-chart card.
  Reversing this is a decision, not a bug fix.
- **`by-handle` is the one non-TypeID path segment on `/api/v4`.** Unavoidable for an "I only have the
  integer handle" resolver, which `?systemId=N` needs forever.
- **`GET /api/v4/devices` deliberately omits `capabilities`**, which §9.2 lists. It is absent from the
  legacy twin too (so this is not a narrowing), and each entry would cost a full capability walk.
  Documented as a future `?include=capabilities`.
- **`?include=resolved` on `GET /api/v4/dashboards/{id}` was never built and is not needed.** It is named
  in clean-sheet §9.2 and §9.4, but the editor's names come from the readable-areas list and the seed
  renders via `router.refresh()`. Left as a future nicety, not an obligation.

## 6. Open follow-ups the epic deliberately did not close

- **`POST /api/v4/dashboards` is not atomic** — it creates the row, then writes the doc. A 500 in between
  orphans an empty dashboard. A real fix needs a transaction spanning two DAO functions.
- **`scripts/utils/v4-surface-smoke.ts` has a self-inflicted flake.** Its `SELECT token FROM share_tokens`
  has no `ORDER BY` while the run churns that table, so which token wins varies and one authorization
  assertion intermittently fails. Fix is an `ORDER BY` plus picking the "other" area from outside the
  token's actual scope. ⚠️ **If a smoke run disagrees with itself, re-run before believing the first
  number.**
- **The `members` `PUT` full-replace contract has one carve-out** — a `vendor='helper'` member is
  server-managed and is never evicted by omission. A client that read `members`, filtered to its
  picker's real devices and PUT that back would otherwise delete the area's blend bindings and blank its
  provenance card until the next daily recompute. Documented at the handler; it is a real semantic
  exception in a contract that otherwise reads as declarative.
- **Run-interval cost/emissions columns** — see [run-period-provenance.md](run-period-provenance.md).
  Phase 14 made the statistics signal-neutral; the load-side provider is still open.

## 7. Traps and rules

Each was learned by breaking something. This list is the reason the per-phase narratives could be
deleted — read it before touching a migration, a column drop, or a route port.

### Migrations and drops

- 🛑 **Drops invert the ordering rule.** "Migrations lead code to prod" is the **additive** rule. For a
  DROP, **deploy the code that stops referencing the column first.** A projection-less `.select()`
  expands to the columns declared in the _running_ build, so any column drop breaks prod until the new
  build is live. (Learned by breaking prod during 0037.) **This applies to `liveone-dev` too** — it is
  shared by every worktree, every Vercel preview and local dev, so "apply on dev only" is not a sandbox
  instruction.
- 🛑 **A projection-less `.select()` is invisible to every grep.** `select().from(areas)` names no
  columns, so a reader of a doomed column leaves no string to search for. **Before a column drop, delete
  the field from `schema.ts` first and let `tsc` enumerate the readers.** That is the only complete
  inventory. It found `lib/admin/get-areas-data.ts` in Phase 13 after a ~48-site sweep and every raw
  grep had missed it — and then found its sibling `lib/admin/get-dashboards-data.ts` in Phase 14, the
  same shape in the same file family. 🆕 **And a hand-written interface mirroring the row is a second,
  independent inventory**: deleting the schema field enumerates _schema-typed_ readers only, so a
  parallel `interface` declared independently of the schema surfaces a whole second wave only after you
  delete its field too.
- 🛑 **A gate is verified by making it FAIL, not by the migration succeeding.** Three gates this epic
  passed their happy path and were wrong:
  1. **Expression indexes store `0` in `indkey`, not the attnum**, and **an index's dependency on a
     column _is_ `deptype = 'a'`** — so the obvious "skip the column's own attribute wiring" filter
     discards exactly the dependents you are looking for. The gate passed with an expression index on
     the column, and the column dropped, taking that index silently with it. 🛑 **Corollary: `DROP
COLUMN` takes indexes with it _without_ `CASCADE`, so CASCADE-avoidance protects nothing — the
     gate has to.** Use an unfiltered `pg_depend` sweep.
  2. **`sum()` over `double precision` is order-dependent**, and Postgres promises no common scan order
     across two separate aggregates. A before/after sum comparison differed in the last digit over 77
     rows — meaning the gate **would have flakily aborted a correct prod apply**, firing sometimes, on
     good data, mid-migration, with every instinct pointing at the change rather than the gate. **Cast
     to `numeric` before summing** — exact and order-independent.
  3. **A `>= 0` predicate lets NULLs slip through un-counted**, because `NULL >= 0` is NULL, not false.
     "Zero rows are non-negative" can be true merely because they were all NULL. Write
     `(… AND … AND …) IS NOT TRUE`, which counts NULL and FALSE alike.

  **The general rule: never ship a gate you have not watched fail**, and justify a widened gate by
  running the _new_ controls against the _old_ predicate rather than by assertion.

- 🆕 **A migration can carry its own oracle.** 0053 had to encode a uuid as a TypeID _in SQL_. Rather
  than trusting an offline proof, its gate verified the SQL encoder against the `ar_` refs already
  stored in `dashboards.doc` — values written by `lib/ids` in production code — so the encoder was
  checked **at apply time, on the target database**, and aborted if it reproduced none or if no oracle
  existed. This generalises to any encoding migration. 0054 (a DROP) transferred it in weakened form:
  a DROP runs no computation, so what it verifies instead is **the claim that justifies the
  destruction** — that every `ar_` ref in the doomed column also appears in the survivor.
- 🛑 **Validation belongs INSIDE the migration**, as a `DO` block with `RAISE EXCEPTION` — the only check
  that cannot be raced between probe and apply. Never `CASCADE` a drop: an unexpected dependent must
  abort, not vanish. And **`db:pg:migrate` swallows `RAISE NOTICE`**, so capture inventories by hand.
- 🛑 **Post-check the CATALOG, never the migrate output.** `db:pg:migrate` prints "applied successfully"
  from a checkout that _lacks_ the migration file (it connects, finds nothing pending, exits 0), and
  does the same on `liveone-dev` when the journal already carries the entry. Confirm the migrations
  directory actually contains the file, then check the catalog. **Preconditions read the catalog too,
  never the drizzle journal** — the journal records intent, the catalog records what is true of this
  branch.
- 🆕 **`/api/health?migrations=1` is a precise deploy probe**, not just a health check: `expected` is the
  journal count _in the running build_. Waiting for `expected` to reach N+1 is how you know the code
  that stops touching a column is actually live before you drop it.
- 🛑 **Write down the expected output BEFORE the apply, per environment.** 0053 expected "4 rows
  rewritten" on prod and "6" on dev; **a prod run reporting 6 would itself have been the red flag.**
  Where the two environments have identical shapes that check does not exist — do not invent one.
- 🛑 **A row-count inventory is not a backup.** Before an irreversible drop, take a real
  `pg_dump --data-only` of every doomed table. Write it under gitignored `.context/` — these dumps carry
  serials and vendor ids and **the repo is public**.
- 🛑 **Re-assert an equivalence inside the migration that destroys your ability to check it.** After a
  DROP there is no second address left to disagree with, so a divergence introduced since the last check
  becomes silent and permanent. **A check that can only ever run once should run.**
- 🛑 **A column drop is only half the change when a persisted derived store keys off it.** The KV
  subscription registry had to be rebuilt on both environments _between_ the deploy and the drop. That
  is a deploy step, and it belongs in the PR body and the migration header, not in a reviewer's memory.
- ⚠️ **Every migration goes to prod FIRST, then dev.** `prod-dev-sync.ts` reads its column list at
  runtime, so a _dev_ column prod lacks trips the schema preflight. Prod-first was **load-bearing** for
  0053 for a second reason: the `devices` sync leg is a full replace, so a dev-first apply would have
  been silently reverted by the next two-hourly sync.
- ⚠️ **Parallel workspaces collide on migration numbers.** `git fetch origin main` and check both the
  directory and the live journal before generating.
- 🛑 **Never `pscale role reset-default` on prod.** It rotates the `postgres` password that prod's
  Production-scope vars carry, and Vercel captures env at deploy time — prod 500s until redeployed.
- ⚠️ **A dev-side check is only evidence about prod when the sync is demonstrably green.** Probe prod
  directly under a short-TTL read-only role, and confirm it really is prod two ways (the role username
  carries the prod branch token; `max(measurement_time)` is seconds behind, since dev's crons are off).
  🆕 **And dev is not always a representative test bed**: the 0055 backfill had 74 rows of the shape it
  needed on prod and **zero** on dev. A green dev run proved nothing; the v1-shaped rows had to be
  constructed in a rolled-back transaction.
- ⚠️ **Drizzle snapshot drift is a trap for the _next_ migration.** A stale `meta/NNNN_snapshot.json`
  leaves `main` carrying a pending diff, so the next `db:pg:generate` emits a **duplicate** DDL
  statement that fails on apply. Verify with `db:pg:generate` → _No schema changes_ after any
  hand-written migration.

### Writers, not readers

- 🛑 **Every v4 column was wired at MINT and not at EDIT.** Before converting a read path to a v4 column,
  **enumerate its writers, not its mint site.** Six instances across Phase 12 alone. Assume the next
  exists until you have listed the writers.
- ⚠️ **Nullability that preserves behaviour also hides a missing writer.** "Null inherits the old MISS
  semantics exactly" is a real safety property _and_ the reason a writer gap is invisible.
- ⚠️ **A NOT NULL column cannot be healed by a fill-if-NULL reconcile — it never looks missing.**
- ⚠️ **Adding an FK to a column that a pre-mint writer fills breaks FIRST CREATION ONLY**, and an
  `ON CONFLICT … coalesce` masks it on every idempotent re-run. An FK addition needs a
  create-from-scratch test, not a re-run test. That is how a prod device-create 500 hid for three days.
- ⚠️ **Exercise WRITERS, not just readers, at the end of a slice.**
- ⚠️ **A DELETE predicate must be driven POSITIVELY** — `inArray(<leaving>)`, not
  `notInArray(<staying>)`. It fails silently in both directions, and a fixture that clears the children
  before deleting the parent only ever runs the statement against zero rows: it proves the SQL parses,
  not that it selects the right rows.
- 🛑 **A `max(x)+1` scan is a PATTERN, not an allocator — grep the TABLE, not the function.** One plan
  named a single allocator; there were five, and three of them also skipped the mirror the fourth called.

### Ports, routes and the wire

- 🛑 **A replacement payload narrower than its consumer needs fails as an EMPTY RENDER, not an error.**
  This was the single most-repeated defect of Phase 14, three times over: `GET /api/v4/areas` and
  `/areas/{id}` both dropped `legacySystemId`, which the client reads to derive the handle every card
  binds to — re-pointing at the v4 route would have made **every card render a skeleton forever**, with
  no error, no 404 and no console warning; and `members[]` carried only the `dv_`, so a picker
  addressing `/api/device/{handle}/points` would have silently lost the points of any member device.
  **When replacing a route, compare the payload key-by-key against the twin it replaces. A status-code
  assertion proves nothing.**
- 🆕 **A blanket absence-assertion over a serialized payload can enforce a defect.** A test asserting
  `not.toMatch(/legacySystemId|…/)` over the response body was _pinning_ the bug above in place. Ban
  legacy _identity_ keys by name; assert the keys you need are **present**, including their null case.
- 🛑 **A refused-at-the-edge 404 is byte-identical to a not-found 404.** Clerk middleware rewrites
  unauthenticated API calls to 404 before the handler runs, so **404 is not evidence that a resource is
  gone.** A cleanup routine that read 404 as "already deleted" was leaking live scratch dashboards —
  and a leaked dashboard can carry live share tokens, which are anonymous credentials on a shared
  database. Treat only a 200 as proof of deletion, and settle the rest against the database.
- 🛑 **Each v4 twin needs its own `lib/route-matchers.ts` entry, and the entries are deliberately
  surgical.** Middleware runs _before_ `next.config` rewrites and sees the original path, so a missing
  entry is a silent edge 404 — invisible to a logged-in tester, broken for an anonymous share-token
  viewer. Do not widen an existing pattern to dodge a merge conflict. The discriminator worth asserting
  is **401-from-handler vs 404-from-edge**: a logged-in tester sees 200 either way, so losing that
  distinction silently removes the proof.
- ⚠️ **Renaming an API path breaks already-open browser tabs**, for the same reason renaming a QStash
  message key breaks in-flight messages: a deploy leaves stale bundles live.
- ⚠️ **A doc comment describing dispatch order, or naming a future slice, is a CLAIM about code.**
  `resolveHandle`'s "area-first" prose was simply wrong and nearly re-pointed a shared dashboard; three
  separate "until slice M" comments were stale by the time M ran. Verify before following.

### Tests, types and proof

- 🛑 **A green `tsc` is evidence only about the type-checked tree.** `tsconfig.json` excludes `scripts`,
  `tests`, `legacy` and `packages` — so for three merges the `/api/v4` smoke driver sat **syntactically
  broken on `main`** while `tsc`, `build:local` and jest were all green, because none of them parse that
  file. Worse, a block-scoped shadow inside it had silently disabled every key-by-key narrowing check,
  including the guard added to stop the highest-risk silent failure of the phase. **A file outside the
  type-checked tree is only verified by being EXECUTED.** Partly fixed since: `tsconfig.scripts.json`
  now type-checks `scripts/` as a second `npm run type-check` pass (deliberately _not_ wired into
  `prebuild`, so a half-finished one-off cannot block a deploy), plus an esbuild parse gate at
  `scripts/__tests__/smoke-driver-parses.test.ts`. `tests/`, `legacy/` and `packages/` are still outside.
- 🆕 **When a lesson recurs after being written down, the write-up was the wrong instrument — make it
  executable.** "An additive conflict is not automatically a mechanical one" was already recorded in the
  working notes when the exact same bad merge happened again. Advice does not run; a parse gate does.
- 🛑 **Pairwise-clean does not compose to n-way clean.** Two PRs each ran `git merge-tree` against a
  third and both correctly reported no conflicts — but nobody checked the pair where the real conflicts
  were. Do an actual n-way merge in a scratch worktree before believing a set of PRs is safe. And when
  resolving: **check the seam, not the marker count.** Concatenating two adjacent additive hunks
  swallowed a closing brace and the opening of the next comment.
- 🛑 **A type move leaves importers that only fail on a REBASE, not on either branch alone.** One branch
  moved a type out of a module; another still imported it from the old home. Both branches were green.
- 🛑 **Two ways to write a jest test in this repo that is silently never run.** All three configs are
  `testEnvironment: "node"` with `testMatch: **/__tests__/**/*.test.ts` — **a `.tsx` test file is not
  collected** — and `roots` are `lib`/`app`/`scripts`/`packages`, so **anything under `components/` is
  not collected either.** Put React-adjacent helpers and their tests under `lib/`.
- 🆕 **Prop-level equivalence is a sound substitute for pixel equivalence.** Four card plugins bottom out
  in chart.js on a `<canvas>` (zero DOM) and there is no jsdom or testing-library in the repo, so pixel
  proof is not available at reasonable cost. But the leaf components were unchanged, so **identical
  props ⇒ identical pixels**: mock the leaves, capture what each plugin hands them, and diff. That
  harness (`lib/dashboard/__tests__/v4-render-props.test.ts`) is what made the riskiest change of the
  epic reviewable — `leaves` 0 of 22 changed across both the prop re-shape and the registry merge.
  Assert the key **set** as well as the values, so a plugin that silently stops being invoked fails.
- 🆕 **Reproduce a suspicious diff on the BASELINE tree before investigating it.** Two apparent visual
  regressions were reproduced on the unchanged tree in minutes, settling them as pre-existing. This is
  cheaper than reasoning about them and it is the first thing to try.
- ⚠️ **A mocked query-builder chain encodes arity**, so re-shaping a query is a test change by
  construction — a stale chain returns `undefined` and yields zero rows _silently_. If re-shaping a
  query did not require touching its mock, the mock is not asserting anything.
- ⚠️ **Hand-written `sql` fragments are invisible to tsc** — a rename or drop breaks them silently, so
  they must be _driven_, not compiled. **The single most reliable failure mode of the whole migration —
  it bit six times in Phase 12 alone.** Re-run the raw-SQL grep by hand before every drop.
- 🛑 **A parity gate over two homes for one value must be DIRECTIONAL.** The two directions mean opposite
  things — one is a serving loss, the other the designed end state — so a symmetric equality check
  either fails on correct data or gets widened into a tautology. State the authority; assert only the
  losing direction; make any repair one-directional and NULL-only. This bit three separate gates.
- ⚠️ **When a check becomes DB-enforced, replace it with the next unenforced invariant, or delete it.** A
  passing tautology reads as coverage.
- 🛑 **A pre-flip reconcile tool REVERSES direction the moment the flip lands**, and its drift report
  inverts with it — reading as alarming when it is correct. Delete such a tool at the flip; a spent
  one-shot that still runs is worse than no tool.
- ⚠️ **Read the producer, not the consumer, before sizing a conversion**, and ⚠️ **removing an FK turns
  any join onto the replacement key into a silent filter** — prefer a replacement join that is itself
  FK-backed and NOT NULL.

### Operating on shared infrastructure

- 🛑 **`liveone-dev` is SHARED** by every worktree, every Vercel preview and local dev. One mutating HTTP
  driver at a time; create and delete your own scratch entities.
- ⚠️ **Cap the pool in every worktree: `PLANETSCALE_POOL_MAX=3`.** The default is 10 connections per
  process against a **single-node** dev branch. Three concurrent workers exhausted it and Postgres
  returned `53300 remaining connection slots are reserved` — which surfaces as an unexplained 500 on a
  cold route that works on retry. **That symptom is capacity, not code.**
- ⚠️ **The two-hourly prod→dev sync rewrites config rows mid-run.** Two distinct transients were chased
  as defects and were not: an area briefly missing its `legacy_handles` row drops out of the readable
  set, and a sync that rewrites `areas.owner_user_id` to prod ids can drop a multi-member area out of
  the dev test user's readable set entirely. **Build fixtures; do not borrow them.**
- ⚠️ **`git stash` is repo-wide, not per-worktree** — parallel worktrees share one stack, and
  `lint-staged` shells out to it. Commit instead.
- ⚠️ **A stale `.next-build/types/validator.ts`** fails `type-check` with `TS2307` after a rebase across
  a route rename. `rm -rf .next-build`.
- 🛑 **A QStash queue pause is EVENTUALLY CONSISTENT in both directions — a DB watermark is the wrong
  instrument for detecting when it took hold.** Already-dispatched messages keep landing for 1–2 minutes
  after the API returns 200, and the same lag applies on resume. Sampling `max(created_at)` during a
  pause shows watermarks _advancing_, which reads exactly like "the pause failed, there is a second
  write path". **Wait ~90 s, and confirm against the QStash event log, not the database.**
- 🛑 **Run a retiring oracle while it still exists.** The pre-drop parity check was banked _before_ the
  PR that deletes it merged; otherwise you are improvising from a detached checkout with the queue paused.
