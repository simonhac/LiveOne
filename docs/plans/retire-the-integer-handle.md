# Retire the integer handle

**Status:** proposed, not started · raised 2026-09-09 · successor to the `AREA_OF_ONE_CANNOT_ADD`
guard removal (same date)

## Why

`legacy_system_id` — the integer that addresses a device *or* an area — is the last piece of
pre-config-v4 addressing still load-bearing. It is a **polymorphic address in a shared namespace**:
the same integer can name two different subjects, and nothing in the type system knows which.

The clean sheet already called this out. From the locked-decisions table in
`docs/architecture/areas-and-dashboards.md`:

> **Overturned.** The integer handle is the clean sheet's *headline deletion* — a polymorphic address
> where `≥1,000,000` meant "synthetic area" and nothing in the type system knew. It dies in Phase 13;
> `legacy_handles` resolves `?systemId=N` forever as a thin compat shim.

Phase 13 moved the *keyspace* to TypeIDs and left the shim. Phase 14's 22 stages do not touch it
(stage 22 is closeout). So the shim is now the whole remaining job, and it has no owner.

### What the ambiguity costs today

Two separate mechanisms exist purely to disambiguate one integer:

1. **`lib/dashboard/subject.ts`** pins a LOCKED precedence — `?systemId=13` means the **device**,
   never the area, *"Behaviour-preserving… Resolving area-first would silently widen handle 13 from
   its device's own 12 points to its area's bindings — a scope change on a shared dashboard."*
2. **`lib/kv-subjects.ts`** does the opposite for reads — *"A handle names up to TWO subjects, and
   the read must visit both"* — enumerating every leg and unioning them.

Both are correct and both are load-bearing. Neither would need to exist if the address were
unambiguous. A third mechanism, the `AREA_OF_ONE_CANNOT_ADD` guard in
`app/api/v4/areas/[id]/members/route.ts`, was removed on 2026-09-09 as redundant with these two —
that removal is what surfaced this plan.

## Scope

Measured on `main` at `500c8d2b` (non-test):

| Surface | Count |
| --- | --- |
| `legacySystemId` / `legacy_handles` references | ~360 lines across ~25 modules |
| Route files under `app/api` mentioning `systemId` | 50 |
| Heaviest modules | `app/api` (14 files), `lib/areas` (11), `lib/registry` (4), `lib/battery-provenance` (4), `components/area-builder` (4) |

The two disambiguators above, plus `DeviceRegistry.resolveHandle`, `lib/registry/device-config.ts`
(`deviceByHandle` / `areaByHandle`) and the `legacy_handles` table itself, are the core. The long
tail is call sites that pass an integer where a `dv_`/`ar_` would now do.

## Shape of the work

Expand/contract, in this order. Each step is independently landable and independently revertible.

1. **Inventory and classify** every `systemId` call site into: (a) wire-facing (`?systemId=` query
   params clients still send), (b) interior plumbing that could take a TypeID today, (c) storage.
   Do this first and write the counts down — the estimate above is a grep, not an audit.
2. **Interior first.** Convert (b) to `DeviceId`/`AreaId` bottom-up. No wire change, no migration;
   `resolveHandle` stays. This is the bulk of the ~360 and is pure refactor.
3. **Wire second.** Every client that sends `?systemId=` gains a `?deviceId=`/`?areaId=` twin
   (both already exist and are *"unambiguous by construction"* per `subject.ts`), then the client
   moves, then the alias is deprecated. Dashboard docs already store `ar_`/`dv_` refs, so the
   dashboard tree needs no doc migration — confirmed by `[[config-v4-id-typeid-seam]]`.
4. **Delete the disambiguators.** Once nothing resolves a handle, `subject.ts`'s device-first
   precedence and `kv-subjects.ts`'s two-leg union both become dead and go. **This is the payoff** —
   the ambiguity stops being *managed* and starts being *impossible*.
5. **Drop `legacy_handles`** and `areas.legacy_system_id` / the devices' handle column, as a
   contract migration, after a full deploy cycle with the shim provably unread.

## Traps

- 🛑 **`?systemId=N` is a public alias on a SHARED dashboard.** Handle 13 backs a share token.
  Changing what it resolves to changes what an anonymous viewer sees. Step 3 must treat the alias as
  a frozen contract until its last caller is gone — see `[[shared-dashboard-endpoint-auth]]`.
- 🛑 **Do not delete areas-of-one as part of this.** Different question, already decided the other
  way: `point_readings_flow_attr_1d` and `battery_provenance_daily` are keyed by area uuid, so
  deleting one destroys history. `retire-implied-areas.ts` is abandoned and must not run.
- 🛑 **`legacy_handles` rows are written `coalesce(existing, new)`** — a leg, once present, is never
  changed, only added. Any migration that *rewrites* a leg breaks the cache-staleness argument in
  `kv-subjects.ts` (a stale entry can currently only be incomplete, never wrong).
- 🛑 **Synthetic handles ≥ 1,000,000 are not a separate type.** Areas created via
  `POST /api/v4/areas` get one (e.g. High Street Kew = 1000003). Code that special-cases the range
  is code that must die with the handle, not be preserved.
- The `n_…` node ids in `dashboards.doc` are minted per environment and are **not** portable
  prod↔dev; any doc sweep runs separately in each.

## Definition of done

`grep -rn 'legacySystemId\|legacy_handles' --include='*.ts' --include='*.tsx'` returns nothing
outside a migration file, `subject.ts`'s `SubjectPreference` type is gone, and `kv-subjects.ts` is
deleted rather than simplified.

## Verification

- `npm run build:local && npm run typecheck` at every step.
- `scripts/utils/v4-surface-smoke.ts` after each of steps 2–4 — it exercises the area/device/dashboard
  write surface end to end against a live deployment and is the closest thing to an integration gate.
- After step 4, confirm a colliding handle's dashboard renders identically before/after: handle 13
  (Kutis device + High Street Kew's members) is the natural fixture, since it is the case every
  disambiguator was written for.
