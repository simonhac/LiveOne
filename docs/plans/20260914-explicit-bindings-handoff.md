# Handoff — explicit bindings, grid signals, and area cleanup

> **Status:** active handoff, written 2026-09-14, for work started on branch
> `simonhac/ha-device-area-mapping-v2`. **Self-contained** — everything needed to execute is here;
> no companion plan doc to read first.
>
> **Delete this file once the work lands.** A handoff that outlives its task becomes a description of
> a branch that no longer exists; git is the archive.

## Goal / definition of done

Two separable pieces. Piece 1 does not depend on piece 2 — ship it first.

**1. Land three finished, green changes** sitting uncommitted on the branch. Done = merged via PR.

- **prod-dev-sync cleanup** — remove the now-dead `devices.primary_area_id` `transitional: true`
  repoint leg from the manifest in `lib/readings/prod-dev-sync.ts`. Migration 0074 dropped that
  column, so the catalog filter already retires the leg at runtime. Keeps the `transitional`
  mechanism (it is the expand/contract seam for the next dropped repoint column) and re-anchors three
  comment blocks that still narrate the deploy window in the present tense.
- **Ambient binding carve-out** — `replaceBindings` (`lib/areas/create.ts`) now accepts a point whose
  owning device is a member **or** ownerless. An ownerless device is public by construction (the
  OpenElectricity NEM regions) and `assertDevicesRehomable` refuses to place one in any area, so
  membership is an unsatisfiable condition for it rather than a protective one. The owned-device
  firewall is untouched. **This is the one prerequisite piece 2's grid-signals design needs.**
- **Unit fail-closed** — `convertUnits` (`lib/site-data-processor.ts`) no longer defaults a missing
  unit to watts. It was called as `convertUnits(dataSeries.units || "W")`, silently dividing an
  unidentified value by 1000; it now matches `convertToKw` in `lib/charts/lines-data.ts`, which
  already failed closed.

**2. Decide, then execute, the explicit-bindings design below.** Done = approved and staged, or
explicitly parked with a status line saying so.

---

## The design: retire the implicit membership union

### The problem

An Area resolves its serving point set **two different ways, and the two disagree.**

`PointManager._resolvePointsForHandle` (`lib/point/point-manager.ts`) is bindings-**XOR**-members:

```ts
if (boundUids.length > 0) { /* the bound points ARE the set */ }
// No bindings → default to the union of the area's member devices' own points.
```

`buildSubscriptionRegistry` (`lib/kv-cache-manager.ts:369`) is bindings-**UNION**-members, always —
it walks the bindings, then walks `getAreaMemberPointsForServing()` and adds every member point not
already bound.

So for an area *with* bindings, history/charts/flow serve the curated set while the KV live map
publishes that set **plus every unbound member point**. Nothing reconciles them and nothing names it.

The XOR half has a second cost: because bindings are an override rather than an addition, **adding a
first binding to an area silently NARROWS it** from "everything my devices produce" to "this one
point".

It also makes `replaceBindings`' unconditional `DELETE ... WHERE area_id = $1` quietly dangerous:
machine-written rows (`ensureHelperBindings`) survive only because callers happen to echo back every
row they fetched. That is a convention held in the client, not an invariant held by the server.

### The change

**The rule: no reconcilers. Commands are fine.** A *command* runs once, on user action, and never
re-asserts — its rows are then ordinary user-owned data: editable, deletable, and they stay deleted.
A *reconciler* runs on every mutation and fights the user. This is Home Assistant's "generated, then
take control", except we skip straight to materialised.

1. **Delete the union fallback** in `_resolvePointsForHandle`. An area's point set *is* its bindings.
2. **Make KV agree** — drop the member-union leg at `lib/kv-cache-manager.ts:369`. This is the change
   with the real risk surface; see Risks.
3. **Backfill the one union-mode area** per environment: materialise what it resolves today as
   explicit bindings, asserted byte-identical before/after.
4. **A create-time command** so a new multi-device area is usable immediately — the same "bind the
   obvious things" logic, run once, on user action. **Must land in the same PR as step 1**, or
   onboarding produces an area that serves nothing.
5. **`ensureHelperBindings` becomes a command too**, or keeps a narrow, *stated* exemption. Once
   nothing else writes bindings, `replaceBindings`' full-replace is correct by construction.

### What it buys

- One resolution mode; the two paths stop disagreeing.
- The silent-narrowing trap becomes unrepresentable.
- `devices.area_id` gets exactly one meaning: **placement**, plus the candidate set for the picker.
- Grid signals need no reconciler, no `areas.config.gridSignals` opt-out, and no
  generated-vs-authored fight.
- It is HA's actual model: the energy dashboard is configured by explicitly naming statistic ids, not
  derived from area membership.

### Risks

🛑 **The KV shrink is the one that can bite.** Today an area's live map carries every member point,
bound or not. After step 2 it carries only bound points. Any card reading an unbound path from an
area's `latest` map goes blank — in production, at render time, with no error. **Gate this on an
enumerated diff of the subscription registry before/after**; expect a strict subset and treat any new
entry as a bug.

**Kutis is a genuinely odd case.** Its one member is a retired helper with frozen provenance. Confirm
what it actually serves before materialising it — the honest answer may be "nothing, archive it".

### Verification

- 🥇 The area point-set parity harness (`docs/plans/area-point-set-parity-harness.md`): every area's
  resolved point set byte-identical before/after, all 17.
- KV subscription-registry diff, pre/post — strict subset, every removed entry accounted for.
- `npm test`; `npx tsc -p tsconfig.json --noEmit` and `-p tsconfig.scripts.json`; `npm run knip` at 0.
- Re-run `scripts/area-builder-smoke.ts` and `scripts/utils/v4-surface-smoke.ts`.

### Stage order

| # | Stage | Ship | Revert |
| --- | --- | --- | --- |
| 1 | Backfill the union-mode area's bindings (dev, then prod) | data | delete the rows |
| 2 | Create-time binding command | code | revert |
| 3 | Delete the union fallback in `PointManager` | code | revert |
| 4 | Drop the KV member-union leg + registry rebuild | code | revert + rebuild |
| 5 | `ensureHelperBindings` → command; state the `replaceBindings` invariant | code | revert |

---

## Decisions already made — do not re-litigate

- **Grid signals will be attached by BINDING the shared ambient OpenElectricity device**, not by
  minting a per-area grid device and not by a jsonb pointer in `areas.config`.
  🛑 `docs/plans/finish-grid-signals-retirement.md` still proposes that jsonb pointer and is
  **stale on its remedy** — its diagnosis (that `lib/grid/context.ts` resolves a capability from
  `area.location` at render time, and should go) is still correct. Fix or annotate it before
  following it.
- **That needs no migration.** `area_bindings.metric_type` has no CHECK constraint, and `grid` is
  already in `area_bindings_role_check`. An earlier idea to add a `market` role was wrong and
  abandoned — non-flow-ness lives on `metric_type` (`battery`/`soc` is the existing proof), not on
  `role`.
- **No reconcilers; commands are fine** (see above).
- **Empty areas: archive by default.** `areas.status` already carries `active | archived | removed`
  and both non-active values are already in use. A hard-delete verb is acceptable to build — see the
  handle constraint below.
- **Unit handling fails CLOSED** — an unrecognised or missing unit is never scaled on a guess.

### Decided but NOT done, and NOT approved

Renaming the OpenElectricity logical paths to match the `grid` role's anchor stem. `ROLES.grid.stem`
is `"bidi.grid"` and `stemMatchesRole` matches the anchor or a dotted descendant, so `grid.*` points
are bindable **only** via a carve-out at `lib/areas/slots.ts:215`
(`role === "grid" && stem.startsWith("grid.")`).

| point | verdict |
| --- | --- |
| `grid.renewables` → `bidi.grid.renewables` | yes — both `%`; chains with Amber's identical path |
| `grid.emissionsIntensity` → `bidi.grid.emissionsIntensity` | yes — no Amber twin, nothing to reconcile |
| `grid.price` | **no** — Amber's `bidi.grid.spot` is `cents_kWh`, OE's is `$/MWh`. Needs the serving edge to convert (`docs/plans/ha-parity-and-leapfrog.md` #6), not a data rewrite |
| `grid.demand` | **no** — MW, and `grid`/`power` is where the real site meters live |

Doing the rename lets the `slots.ts:215` carve-out be deleted. **Do it before any binding seed** —
nothing binds those points yet, so this is the cheapest it will ever be. `lib/grid/latest.ts`
hardcodes all four serving keys and must change with it. Definitions live in
`lib/vendors/openelectricity/point-metadata.ts`.

---

## Measured facts that are expensive to re-derive

Measured 2026-09-14. Re-verify before acting.

- **Prod holds no orphaned data.** All 17 prod areas via `liveone area provenance` (window
  2024-01-01 → 2026-09-14): only `Daylesford` (flow 1749), `High Street Kew` (445) and
  `Kinkora Unified` (8222) hold rows. All 13 emptied areas-of-one report
  `flow 0 · provenance 0 · bindings 0 · agg5m 0 · agg1d 0`, as does `Kutis`. Nothing to purge.
- 🛑 **`liveone-dev` disagrees and dev is WRONG.** Dev shows `Kuti House` with 235 flow rows,
  `Daylesford Selectronic` with 10, and 12 stale `Kutis` bindings (6 pointing at a device re-homed to
  High Street Kew). Prod deleted all of these correctly. They survive on the mirror because the
  2-hourly prod→dev sync is an UPSERT that mostly does not delete. **Never judge an orphaned-data
  question from dev.**
- 🛑 **A hard delete must `UPDATE legacy_handles SET area_id = NULL`, never `DELETE` the row.**
  16 of the 17 empty areas share their handle row with a device (an area-of-one inherited its
  device's handle); deleting the row destroys the DEVICE's handle mapping. Only `Kuti House`
  (handle 1000001) is area-only. Keeping the row also preserves monotonic allocation —
  `lib/areas/handles.ts` allocates
  `max(max(devices.rid), max(legacy_handles.handle), 1_000_000) + 1`, so removing the top row would
  let the next area reuse that integer.
- **Exactly one area per environment uses the implicit membership union** — prod: `Kutis`, whose sole
  member is the *retired* `Kutis · derived` helper; dev: `Craig (legacy)`.
- **There is no auto-binder.** Only two writers of `area_bindings`: `replaceBindings`
  (user-initiated) and `ensureHelperBindings` (battery-provenance recompute).
- Empty areas are otherwise inert on both environments: zero dashboard-document references, zero
  automations, zero `users.default_area_id` pointers.

---

## Transient state not in the repo

- **Nothing is committed.** The branch has zero commits ahead of `origin/main`; all changes are
  working tree (10 modified, 4 untracked).
- **Migration 0074 is applied to BOTH prod and dev.** Verified: `npm run pg-migrate` dry-run reports
  `pending: []`; dev has no `area_members` and no `devices.primary_area_id`. The prod→dev sync Action
  has run green twice since. No migration work is outstanding.
- **Five files in the tree came from a parallel session, not this work**, and were explicitly adopted
  by Simon: `CLAUDE.md` (+26 lines), `docs/infra-ownership.md`,
  `docs/plans/deploy-time-migrations.md`, and the `docs/README.md` index line for it. They belong to
  this branch now. `CLAUDE.md` is project instructions — call it out in any PR description.
- Gates green at last run: 337 suites / 4360 tests, `tsc` 0 on both projects, `knip` 0.

## Next actions

1. Re-run the gates — the tree is uncommitted, so confirm nothing drifted.
2. Ask Simon whether to split piece 1 into its own PR (the three green changes + the adopted docs)
   ahead of any design work. Recommended.
3. For piece 2, start at Stage order above. Stage 4 (the KV member-union leg) is the one that can
   silently blank cards in production and needs the registry diff as its gate.
4. If Simon wants the empty areas cleaned up, build `liveone area orphans` (read-only census) first —
   it is the evidence the destructive verbs act on, and is useful on its own for dev-drift detection.
   Then `area archive <ar_>` (reversible default) and, if wanted, `area delete <ar_>` gated on an
   assertion of 0 devices / 0 bindings / 0 flow / 0 provenance / 0 automations / 0 document refs.
   Note `liveone area` is currently read-only except `purge`; there is no delete verb today.
   Deleting orphaned *data* needs no new verb — `area purge flows` / `area purge provenance` already
   do it. The only gap is that `purge flows` demands `--start`/`--end` and prints a restore command,
   which is right for a live area and meaningless for an emptied one where nothing can ever recompute
   those rows; consider accepting `--all` when the area has zero devices.

## Out of scope / guardrails

- **Do not commit, push, or open a PR until Simon asks.** Do not suggest a commit unprompted.
- **Do not delete or purge anything on prod** — measured at zero; the orphans visible on dev are
  mirror artifacts, not defects.
- **Any schema change needs explicit approval first.** None of the decided work requires one.
- Do not "fix" `docs/plans/finish-grid-signals-retirement.md` by following it — its remedy is
  superseded.
- The `grid.*` → `bidi.grid.*` rename is **not approved**; it is a recommendation.
