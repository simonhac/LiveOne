# Area point-set parity harness

> **Status:** proposed — not started (drafted 2026-08-01). Mined out of
> `docs/plans/areas-multi-device-refactor.md` before that doc was deleted: its Phase-B/C
> "parity gate" was the single most load-bearing idea in the refactor and the only one that was never
> built as a reusable instrument. This proposal is that instrument, plus the fixture it needs to reach
> the two code paths that have never executed against real data.

## Why

[`../architecture/areas-and-dashboards.md:178-180`](../architecture/areas-and-dashboards.md) asserts,
as a live architectural principle:

> **Resolver changes are gated by parity assertions.** Every change that touches point resolution
> asserts the per-area resolved point set is byte-identical pre/post. This caught real defects through
> three waves of composite retirement and the cutover itself.

Nothing in the repository backs that claim. The gate was real and it did catch real defects, but it was
performed **by hand, three times**, and left no artefact behind: there is no script, no test, and no
stored snapshot that a fourth change could run. The retired refactor doc was explicit that this was
still an action item — `areas-multi-device-refactor.md:211-212` reads "Parity gate (the key regression
test)… **Add a script/test that diffs the resolved set**", and that script was never added.

So the principle is currently an honour system. The next change to `_resolvePointsForHandle` — a
Phase-15 cleanup, a binding-model tweak, a v4 area-shape change — has nothing to gate it with except
whoever remembers to do the diff by hand again. This plan closes the gap between the documented
principle and reality, cheaply, against today's model, with no schema change.

## Today

**What exists that is adjacent but is not the thing.**

[`scripts/area-builder-smoke.ts:1-20`](../../scripts/area-builder-smoke.ts) drives the real serving
resolver (`PointManager.getActivePointsForDevice` → `_resolvePointsForHandle`) and asserts six
properties of it — handle allocation, area-vs-device resolution, union-with-no-bindings, bound-points
override, union growth on member add, refusal to remove the last member. But it does all of that over a
**throwaway area it creates itself** and then hard-deletes. It is a behavioural smoke test of the write
path. It says nothing about any area that actually exists, it does not iterate all areas, and it has no
pre/post dimension at all.

[`lib/point/__tests__/point-manager-handle-dispatch.test.ts:97-191`](../../lib/point/__tests__/point-manager-handle-dispatch.test.ts)
covers the dispatch itself with five cases: a real device loading its own points, the area-of-one
union-of-one parity case, a member-less area resolving to `[]`, the colliding-handle trap (handle 13 is
both a real Sigenergy device and a 3-member area, and must keep resolving the device's own points), and
a handle that names neither. These are the right assertions — and they are fully **mocked**
(`deviceByHandle`, `areaByHandle`, `getAreaBindingRefs`, `getAreaMemberDeviceIds` are all jest mocks,
and `_loadOwnPoints` is spied). They pin the branch structure; by construction they cannot see a single
row of real data, so they cannot detect that a real area's resolved set moved.

**The resolver they would have to gate** is
[`lib/point/point-manager.ts:354-391`](../../lib/point/point-manager.ts): device-first dispatch
(`deviceByHandle`, then `areaByHandle` only if there is no device), then `getAreaBindingRefs(handle)` —
if there are bound uids they ARE the set (the override), otherwise the union of
`getAreaMemberDeviceIds(area.id)`'s members' own points.

**The pattern to copy.** Two existing scripts establish the accepted shape for "drive real SQL against
the dev mirror over synthetic rows":
[`scripts/utils/verify-areas-drift-key.ts`](../../scripts/utils/verify-areas-drift-key.ts) seeds two
synthetic areas in a reserved handle band (9000001/9000002), drives the real prod→dev sync SQL over
them, asserts, and deletes them in a `finally`; it strips the PlanetScale ssl params from
`PLANETSCALE_DATABASE_URL` exactly as `getPoolConfig` does, and refuses a connection carrying the prod
branch id. [`scripts/utils/v4-surface-smoke.ts`](../../scripts/utils/v4-surface-smoke.ts) does the same
for the `/api/v4` surface: name-prefixed scratch rows, a sweep of anything a previous crashed run left
behind, teardown in a `finally`, two independent dev-only guards. Both are `tsx` scripts run as
`npx tsx --env-file=.env.local scripts/utils/<name>.ts`.

## The change

Add **`scripts/utils/area-point-set-snapshot.ts`**, a two-mode script:

- `snapshot <out.json>` — enumerate every area (areas joined to `legacy_handles` for the handle, the
  same areas-backed predicate `getBindinglessAreaMemberPoints` uses in
  [`lib/areas/members.ts:124`](../../lib/areas/members.ts)), call the real
  `PointManager.getActivePointsForDevice(handle)` for each, and write a stable, sorted JSON document:
  per area, its id and handle, and the resolved point set as sorted `point_uid` plus the fields the UI
  actually depends on (`system_id`, `point_id`, `role`, `metric_type`, `unit`, `display_name`).
- `diff <before.json> <after.json>` — exit non-zero with a per-area, per-point unified report of
  additions, removals and field changes.

That is the whole harness. The workflow it enables is the one the architecture doc already describes:
snapshot on `main`, apply the resolver change, snapshot again, diff — and either the diff is empty or
every line of it is a deliberate, explained broadening. It is read-only, so it needs none of the seed/
teardown machinery, and it works against today's model unchanged. It should default to writing to
`.context/` or an explicit path argument rather than into the repo, since a snapshot is an artefact of a
moment, not a checked-in fixture.

Following the house convention for these scripts: dev-only guard (refuse a connection carrying
`PLANETSCALE_PROD_BRANCH_ID`), read-only so no `--apply` flag is needed, and `--env-file=.env.local`
because `tsx` scripts otherwise never see the connection string (the `planetscaleDb` IIFE evaluates at
import).

### Companion problem: the union-default leg is dormant in production

Worth its own work item, because a harness that only diffs paths that execute is a harness with a blind
spot. **Two live code paths have never run against real data.**

[`lib/point/point-manager.ts:338-340`](../../lib/point/point-manager.ts) states it outright: "an
area-of-one's union-of-one is byte-identical to loading the device's own points, and every existing
multi-device area has bindings, so the union-default branch is dormant for current data."
[`lib/areas/members.ts:113-116`](../../lib/areas/members.ts) says the same of the KV fan-out leg:
`getBindinglessAreaMemberPoints` is "empty for today's data (both prod multi-device areas have
bindings) — it only lights up when a binding-less multi-device area appears."

So the resolver's union-default branch and the KV subscription registry's binding-less fan-out are both
correct-by-inspection only. Propose a **binding-less multi-device fixture area on the dev mirror**, in a
reserved handle band, that exercises both legs — the resolver returns the union, and
`buildSubscriptionRegistry` (`lib/kv-cache-manager.ts:238`) actually emits the member-point rows. This
is not new code so much as an extension of what already exists: `scripts/area-builder-smoke.ts` step 3
(`scripts/area-builder-smoke.ts:139-142`) already creates a binding-less multi-device area and asserts
the union point count equals the sum of its members'. Extending that script to also drive the KV leg,
and to leave the fixture in place under a flag rather than always deleting it, gets most of the way
there. The snapshot harness would then have a row in every snapshot that traverses the dormant branch.

## Risks / gotchas

**The prod→dev sync will revert fixture rows.** The 2-hourly sync (`npm run db:sync-dev-db`, and the
`sync-prod-to-dev.yml` workflow) is an UPSERT: any row written to `liveone-dev` that collides with a
prod-existing row gets reverted within two hours, and the areas leg realigns ids by drift key. Use a
reserved id/handle band that prod cannot occupy and clean up in a `finally`, exactly as
`verify-areas-drift-key.ts` (9000001/9000002) and `v4-surface-smoke.ts` (name-prefixed scratch rows) do.
A fixture that survives the sync is a fixture that is about to surprise someone.

**A snapshot is environment-specific.** Dev and prod do not have identical areas, and ids are not
universally comparable across environments (points and derivations are deterministic; areas and
dashboards are realigned by the sync; `devices.id` diverged historically). A snapshot diff is only
meaningful *within* one environment, before vs after. Do not diff a dev snapshot against a prod one.

**The snapshot must go through the resolver, not around it.** Reconstructing the point set with a
hand-written query would pass while the resolver was broken — that is precisely the failure mode the
mocked dispatch test already has. `getActivePointsForDevice` is the entry point; per-request memoization
inside `PointManager` means the loop should be tolerant of caching, or reset between areas.

**Handle 13 is the canary.** A colliding handle (a real device AND an area) must stay at the device's
own 12 points. If a snapshot diff ever shows handle 13 growing, that is trap D-l — a scope widening on a
shared dashboard in the direction that grants access — and not a cosmetic diff.

## Verification

The harness verifies itself the same way `verify-areas-drift-key.ts` does: by being run against a
deliberately introduced difference. Snapshot the dev mirror, add a binding to one area (or add a member
to a binding-less one), snapshot again, and confirm the diff names exactly that area and exactly those
points — then revert. A parity tool that reports "no differences" on a run where a difference was
planted is worse than no tool, so that positive proof should be part of landing it.

Beyond that: `npx tsx --env-file=.env.local scripts/utils/area-point-set-snapshot.ts snapshot …` should
complete over every dev area, and the resulting document should contain a row for the binding-less
fixture area (proving the union-default leg was traversed) and a row for handle 13 showing the device's
own points.

No schema change is involved, so there is nothing to migrate and nothing to approve on that front.

## Related

- [../architecture/areas-and-dashboards.md](../architecture/areas-and-dashboards.md) — §6 makes the
  parity claim this plan is written to make true. **It needs no edit if this lands**: the sentence
  "resolver changes are gated by parity assertions" stops being aspirational and starts describing a
  script that exists.
- `areas-multi-device-refactor.md` — the plan this was mined from; §Verification item 1 was the
  original statement of the gate. Deleted 2026-08-01 (git is the archive); last content is at
  commit `352da181`.
- [../../scripts/area-builder-smoke.ts](../../scripts/area-builder-smoke.ts) — the closest existing
  thing, and the natural host for the binding-less fixture.
- [../../scripts/utils/verify-areas-drift-key.ts](../../scripts/utils/verify-areas-drift-key.ts) and
  [../../scripts/utils/v4-surface-smoke.ts](../../scripts/utils/v4-surface-smoke.ts) — the CLI and
  teardown conventions to match.
