# Exact resolution, or refuse

**Status:** plan · raised 2026-09-15 · Phase 0 shipped, Phases 1-6 not started · companion to
[retire-the-integer-handle.md](retire-the-integer-handle.md)

## The rule

> **Resolve the exact referenced object, or fail loudly. Never a best-effort substitute, never an
> implicit widening or narrowing, never a silent fall-through to a different object.**

This doc is the roadmap for making that true. It is the *safety* track; `retire-the-integer-handle.md`
is the *deletion* track. They converge — an unambiguous address cannot be mis-resolved — but the
deletion is ~360 references across ~25 modules and has no owner, so nothing here waits for it.

## Why — the incident

A dashboard rendered four hatched EV run bands on its chart and, in the panel directly below,
"No charge sessions in this period". Same page, same period, same endpoint
(`/api/device/{systemId}/run-periods?role=ev`), two answers. The data was never in doubt:
`liveone derivation intervals` returns the runs, and one of them is the band the tooltip describes.

The chart card inherits its section's area, so it asked handle `1000003`. The runs card is pinned to a
device, so it asked handle `13` — and handle 13 names **both** a device and a stale area-of-one that the
device has since left. `memberDevices` resolved the area, found only that area's derived helper, matched
no detector, and returned `200 { events: [] }` — indistinguishable from "no runs this week".

Nothing was broken in a way anything could see. That is the defining property of this class.

## The mechanism

`DeviceRegistry.resolveHandle` (`lib/registry/device-registry.ts:190-210`) returns **both legs** of a
handle and deliberately states no precedence — *"Any future caller must choose deliberately. The returned
`HandleTargets` can carry BOTH."* That is a defensible primitive. What is not defensible is what grew on
top of it: **five resolvers now choose, with four different answers, and nothing enforces agreement.**

| resolver | order | protected by |
| --- | --- | --- |
| `_resolvePointsForHandle` (`lib/point/point-manager.ts:390`) | device-first | 🔒 prose **+ a test** |
| `getAreaMemberPointsForServing` (`lib/areas/members.ts:213`) | device-first | prose |
| `requireDashboardAccess` (`lib/api-auth.ts:385`) | caller-chosen (`prefer`) | prose |
| `kvSubjectsForHandle` (`lib/kv-subjects.ts:112`) | **union both legs** | prose |
| `memberDevices` (`lib/capabilities/server.ts:65`) | **area-first** | nothing |

Four of the five are guarded by a prose claim about production data. **All four claims have already
drifted off it:**

| claim | where | truth on prod, 2026-09-15 |
| --- | --- | --- |
| *"since migration 0071 that area holds ZERO devices"* | `capabilities/server.ts:60` | it holds its derived helper — **this is the incident** |
| *"the four handles that are areas ONLY — 7, 8, 1000001, 1000002"* | `dashboard/subject.ts:31` | area handles are 8, 13, 1000002, 1000003 |
| *"18 of 22 handles have BOTH legs"* | `kv-subjects.ts:14` | 1 of 14 |
| *"No handle on prod or dev currently names a device and an area that differ"* | `grid/context.ts:97` | handle 13 does |

A comment cannot be wrong at build time, so a comment is not a guard. Each of these was true when
written and silently stopped being true when the data moved.

`memberDevices` never confronted the question at all, because it reads through
`lib/areas/resolve.ts:getAreaForDevice` — a separate reader that selects **only the area leg**. Its name
says "ForDevice"; it is structurally blind to the device leg.

## The pattern to copy

The repo already solved this exact shape once, for reference columns, in `lib/integrity/ledger.ts`:

> *"The list this replaces had three entries. It was wrong on one of them and missing a fourth… A
> hand-kept list of soft references is a list of the ones somebody remembered. So the completeness claim
> is mechanical instead… Adding a column with a reference in it and not saying what protects it is a
> failing test, not a future incident."*

And the refusal half is already the house standard in the CLI — `scripts/ops/shared.ts:126-148`
`resolveRef` resolves TypeID → handle → slug → name and **errors on >1 hit, naming the ids**, never a
silent first match. Its sibling `matchRef` is exported with a docstring explaining precisely why the
ladder is not duplicated: *"Written as a second copy of the ladder, that caller would be free to disagree
with this one about what a handle or a slug means."*

Both halves exist. Neither has been applied to handle resolution.

## Roadmap

Six phases. Each is independently landable and independently revertible. Phases 1 and 2 are the
load-bearing ones; 3–5 are the tail; 6 is the handoff.

### Phase 0 — the incident ✅ done 2026-09-15

- `memberDevices` (`lib/capabilities/server.ts`) is **device-first**, matching the locked dispatch in
  `PointManager._resolvePointsForHandle`, and the precedence is pinned by
  `lib/capabilities/__tests__/member-devices-dispatch.test.ts` rather than by a comment. The collision
  case in that file fails against the old body and passes against the new — checked, not assumed.
- `run-periods/route.ts`'s `viewingAreaId` resolves through `devices.area_id` for a device handle.
- The route serves `tracked: detector !== null`; `RunsCard` renders a distinct `untrackedText` for
  `tracked === false`. `app/api/device/__tests__/run-periods-tracked.test.ts` pins that the two states
  are distinguishable — the assertion is literally that `events` are equal and `tracked` is not.
- `resolveRunsConfig` replaces the card's `safeParse … : "generator"`, so invalid config renders a
  `ConfigNotice` instead of a confidently mis-roled card. Absent config still defaults (back-compat).
  `runsConfigSchema` is now module-private so the resolver is the only way in.
- The runs card sends its window through `toInstantRange` (`lib/charts/temporal.ts`), fixing the
  separate M/Y defect where tz-naive calendar-day markers were parsed as instants — which shifted the
  window ~10 h in AEST and truncated the inclusive last day at 00:00 UTC.
- **`getAreaForDevice` is deleted.** That was the point: two other sites had already migrated off it
  by name (`lib/grid/context.ts:78`, `app/api/devices/[systemId]/location/route.ts:93`), each with a
  comment explaining the wrong-area class, and fixing the last two callers without removing the trap
  would just have left it armed for the next one.

Verified against the dev mirror: handle 13 and handle 1000003 — the pinned panel and the inheriting
chart — now return **byte-identical** run-periods responses, including the 12 Sep 8:58am–11:35am
session the chart was bracketing while the panel reported none. `tracked` reads `false` for
(handle 1, ev) and (handle 13, generator), `true` for (1000002, generator) and (14, generator).

### Phase 1 — make the precedence census mechanical

Model on `lib/integrity/ledger.ts`. One table naming every consumer of an ambiguous handle and its
verdict — `device-first` | `area-first` | `union` | `unambiguous-by-construction` — with a test that
fails when a new resolver appears undeclared.

The completeness claim has to be derived, not curated: enumerate the callers of `resolveHandle`,
`deviceByHandle`, `areaByHandle` and anything that reads `legacy_handles` directly, and assert each
appears in the census exactly once. That is what makes it different from the four comments above.

Then replace each prose data-claim with an executable one. *"That area holds zero devices"* is a query;
it belongs in a test or a startup assertion, not a comment. Where the claim genuinely cannot be
executed cheaply, it should at least name the query that checks it.

### Phase 2 — close check-A-read-B

Three places authorize one object and read another. On today's prod none of them is an escalation
(see **Checked and not live** below), but each is a correctness defect on its own terms and each becomes
an escalation the moment a second owner or a divergent pair exists.

1. **`prefer:"area"` authorizes the area; the read is device-locked.** `lib/api-auth.ts:385-409` checks
   the area's owner/public/grant scope; `lib/dashboard/serve-data.ts:129-143` then passes the bare
   integer into `_resolvePointsForHandle`, whose 🔒 lock guarantees the **device's** points. The lock
   exists to prevent a widening, and it is what makes the authorized object and the read object differ.
   `lib/__tests__/api-auth.test.ts:239-263` pins the helper's behaviour and stops before the read, so the
   test is right about the function and silent about the system.
2. **`getLatestValues` unions both legs while auth resolved one.** `lib/latest-values-store.ts:167-176`
   → `kvSubjectsForHandle`. So `latest` is wider than `readings` in the same response, and the share-token
   invariant at `lib/dashboard/access.ts:5-15` ("exactly the points its data shows") is computed through
   the device-first path while the payload is the union. The comment at `api-auth.ts:353-358` — *"Both
   legs resolve to that same interior-locked point set"* — is true of `getActivePointsForDevice` and
   false of `getLatestValues`.
3. **`provenance-daily` authorizes the device and returns the area's rows.**
   `app/api/v4/areas/[id]/provenance-daily/route.ts:53-100` calls `requireDashboardAccess` with no
   `prefer`, so it defaults to `"device"`, then reads `battery_provenance_daily` for the area. One
   argument fixes it, and `"area"` is what the route's own `ar_`-native identity means.

⚠️ `/api/device/(.*)` is in `shareableRoutes` (`lib/route-matchers.ts:82`) and `provenance-daily` is the
one shareable `/api/v4` route, so both reach anonymous `?access=` viewers. Share tokens are the reason
this phase is not vacuous under a single user.

### Phase 3 — parse stored documents on read

`lib/dashboard/dashboards.ts:147` does `doc: (r.doc as DashboardV4 | null) ?? null`. The stored
`dashboards.doc` is **cast, never parsed**; `validateDocV4` runs on write only. There are non-API writers
(`scripts/utils/remove-card.ts`, `scripts/ops/dashboard/plumbing.ts`, direct SQL, revisions restored from
`dashboard_revisions.doc`) and any doc written by a *different build* of the validator — a preview deploy,
a rollback — lands unchecked. This is the structural enabler for everything in Phase 4.

The shape guard the auth path uses is near-vacuous too: `lib/dashboard/v4.ts:87-93` checks only
`version === 4 && root.kind === "group"`.

### Phase 4 — no silent defaults in card config

The house rule already exists and is stated outright in `lib/dashboard/heatmap-card.ts:18-22`: *"the
plugin renders a notice rather than guessing (in particular it does NOT fall back to 'unpinned', which
would silently show a device's whole point list on a card whose author asked for exactly one series)."*
`heatmap` and `daily-stripe` both return `null` on a parse failure and render a visible `ConfigNotice`.

Bring the rest in line:

- `components/dashboard/cards/runs.tsx:49-50` — `parsed.success ? parsed.data.role : "generator"` over a
  `z.strictObject`. One unrecognised key renders an EV card as a **generator** card: wrong title, wrong
  `?role=` fetch, wrong live badge, fully rendered and confident. (Phase 0 fixes this one.)
- `components/dashboard/cards/chart.tsx:54`, `components/dashboard/cards/device-metrics.tsx:19,40`,
  `lib/dashboard/temporal-cards.ts:30` — `node.config as T | undefined`, no validation. A typo'd
  `"stacked-area"` draws a standalone lines chart instead of collapsing into the section's group;
  a mis-cast in `temporal-cards.ts` makes the page's temporal navigator silently disappear.
- **The unknown-`type` path is the counterexample to preserve.** `lib/dashboard/v4-validate.ts:146-152`
  warns on write and `components/dashboard/v4/node-view.tsx:188-196` renders a labelled visible
  placeholder. `lib/dashboard/migrate-card-type.ts:5-11` states the intent: *"the failure is visible and
  non-destructive."* A known type with invalid config should fail the same way; today it defaults instead.
- Related: `validateDocV4`'s `warnings` array is returned by the API and surfaced by the CLI
  (`scripts/ops/dashboard/handlers.ts:165`) but **has no web-UI consumer**, so an author editing through
  the configurator never sees an unknown-card-type warning.

### Phase 5 — the silent-substitution tail

Ranked by how silent and how misleading the result is. Each is small and independent.

1. `app/api/observations/receive/route.ts:49-63` — `rows[0]?.vendorType` collapses *unknown device* and
   *non-5m vendor* into `false`, then **caches that in a module-level `Map` with no TTL**. An observation
   arriving for an Amber device before its `devices` row is visible pins first-write-wins for the lambda
   instance's life, silently dropping late Amber refinements. `lib/registry/registry-cache.ts:26-30`
   spends a docblock on why it never caches absence. The safe-default comment is right; the cache write
   on that branch is the bug.
2. `lib/aggregation/logical-system.ts:91-155` — points come from the device (device-first) while `areaId`
   (the primary key of `point_readings_flow_attr_1d`) and `dayOffsetMin` come from the area. Mixes two
   objects by construction; the docblock defends the offset and never mentions the key.
3. `lib/kv-subjects.ts:98` `device ?? area` is called by `lib/system-summary-store.ts:132,146,171`, while
   `getLatestValues` unions. A summary and the latest values it claims to aggregate can describe
   different object sets.
4. **Archiving is not revocation.** Status is filtered in exactly one resolver (`lib/areas/list.ts:136`);
   `areaByHandle`, `getLegacySystemIdForArea`, `resolveAreasByIds`, `loadAreaForAuth` and
   `loadProvenanceArea` all ignore it. An archived area leaves the pickers and `checkDocRefsReadable` —
   so the *owner* can no longer re-save a doc referencing it — while existing share tokens and grants
   keep serving it. Worth settling deliberately, because CLAUDE.md presents `area archive` as the
   reversible retirement verb and an operator could reasonably read that as cutting access.
   Related asymmetry: `loadReadableArea` (read) enforces `active`, `loadAreaForOwner` (write) does not.
5. `lib/registry/device-config.ts:252` `deviceByVendorSite` — first match on a non-unique column with no
   ordering, deciding OAuth/webhook association. `lib/areas/helper.ts:62-70` faced exactly this, saw real
   duplicates on dev, and added `.orderBy(asc(devices.rid))` plus a self-heal; the same fix was never
   applied here.
6. `parseDeviceConfig` drops unrecognised top-level keys and returns 200. `droppedConfigPaths` computes
   precisely this, but its only caller is the CLI lint — the write routes never call it. Three keys have
   already been destroyed this way (`spec`, `batteryProvenance`, `reserveFloorMaxPct`), each found by a
   round-trip test rather than by use.
7. `app/device/[...slug]/page.tsx:79,132` — a device that does not resolve yields
   `systemId = "username/alias"`, a non-numeric string handed downstream as a system id instead of a 404.
8. `lib/point/point-info.ts:139-148` — any unrecognised `metric_type` falls through to `avg`. Averaging a
   cumulative energy register produces a large, stable, entirely meaningless number rather than an empty
   chart.
9. `lib/capabilities/server.ts:80` `memberSystemIds` — a handle naming nothing answers `[handle]`. The
   docstring is honest about why (*"returning [] would silently turn 'unknown device' into 'device with
   nothing on it'"*) but the cure is a different silent answer. Same shape at
   `lib/areas/resolution.ts:160`.

Deliberate and well-argued, listed so they are not re-litigated as bugs: `latest-values-store.ts:120-131`
(after 15 minutes of silence a series answers from a physically different meter, with the `#rank` grammar
stripped before any consumer sees it — the purest instance of the class, and the one with the best
reason), `derivations/resolve.ts:429-450` (first-wins, but the arbitrariness is named and the tiebreak is
deterministic), `areas/resolution.ts:82`.

### Phase 6 — hand off to the deletion track

Once Phase 1's census exists and Phases 2–5 have emptied it of disagreements, the census becomes the
inventory `retire-the-integer-handle.md` step 1 asks for and never had. Its step 4 ("delete the
disambiguators") is then a mechanical sweep of a table rather than a grep, and this doc's rule survives
the handle's death as the thing that stops the next polymorphic address.

## Checked and not live

The ownership-divergence escalations in Phase 2 need a colliding handle whose area owner and device owner
differ. Verified against production, 2026-09-15:

- Area handles are 8, 13, 1000002, 1000003; device handles are 1, 5, 6, 9–16, 10001–10003. **Handle 13 is
  the only collision.**
- Handle 13's area and device are owned by the **same** user.
- No area is ownerless. The two ownerless (public) devices are the OpenElectricity regions, which have no
  area and no matching area handle.

So these are latent, not live — and largely vacuous while there is one user. Share tokens are the
exception, which is why Phase 2 is still worth doing and why Phase 0's "loud failure" item matters: a
silent empty on a shared link is one nobody can check against the CLI.

Re-run before acting on Phase 2:

```sql
SELECT lh.handle, a.owner_user_id AS area_owner, a.status, d.owner_user_id AS device_owner
FROM legacy_handles lh
JOIN areas a ON a.id = lh.area_id
JOIN devices d ON d.rid = lh.handle
WHERE a.owner_user_id IS DISTINCT FROM d.owner_user_id;
```

Every row is a live pair.

## Traps

- 🛑 **Do not "fix" this by deleting areas-of-one.** Already decided the other way:
  `point_readings_flow_attr_1d` and `battery_provenance_daily` are keyed by area uuid, so deleting one
  destroys history. `retire-implied-areas.ts` is abandoned and must not run.
- 🛑 **`?systemId=N` is a public alias on a shared dashboard.** Changing what a handle resolves to changes
  what an anonymous viewer sees. Every phase here narrows or clarifies; none should widen.
- 🛑 **Narrowing an authorization set silently is the same defect in the other direction.**
  `lib/dashboard/composition.ts:28` and `lib/dashboard/access.ts:69-89` fail closed by dropping
  unresolvable refs, which is right in direction — but a scope that shrinks silently is
  indistinguishable from one that was always that size. `lib/areas/ref.ts` states the problem exactly
  (*"a raw uuid therefore does not error — it DISAPPEARS"*) and pushes the guarantee onto the write paths;
  confirm those still hold it before relying on it.
- The `n_…` node ids in `dashboards.doc` are minted per environment and are **not** portable prod↔dev; any
  doc sweep runs separately in each.

## Definition of done

- `getAreaForDevice` is deleted, not merely unused.
- Every resolver of an ambiguous handle appears in the census with a declared verdict, and adding one
  without declaring it fails a test.
- No prose comment is the sole guard of a data invariant this class depends on.
- `dashboards.doc` is parsed on read, and every card plugin either validates its config or renders a
  visible notice — no card defaults on a parse failure.
- The authorized object and the read object are the same object on every route, asserted at the route
  level rather than at the helper level.

## Verification

- `npm run build:local && npm run typecheck` at every step.
- `npm test` — the census test (Phase 1) is the gate that makes the rest durable.
- `scripts/utils/v4-surface-smoke.ts` after Phases 2 and 3 — the closest thing to an integration gate
  over the area/device/dashboard surface.
- `scripts/utils/area-point-set-parity.ts` after any resolver change, per
  [area-point-set-parity-harness.md](area-point-set-parity-harness.md).
- After Phase 0, confirm handle 13's dashboard renders identically to the chart's own bands: the runs
  panel and the stacked chart must list the same sessions for the same window.
