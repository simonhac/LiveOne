# KV store

> **Status:** current — rewritten 2026-07-30 for config-v4 Phase 13 PR 3, which moved the whole
> keyspace off the integer handle onto TypeIDs. Schema-of-record for the key shapes is
> **`lib/kv-keys.ts`** — the single owner of every key string. If this doc and that module disagree,
> the module is right.

The KV store (Upstash Redis, via `@vercel/kv`) is a **disposable cache**, not a datastore. Every entry
in it is derivable from Postgres. Nothing is ever migrated in place: a key-shape change orphans the old
entries and the new ones are rebuilt.

## 🛑 ONE physical store, dev and prod separated only by a key prefix

There is a **single** Redis store shared by dev, preview, prod and tests. The only isolation is a key
prefix applied by `kvKey()` (`lib/kv.ts`), driven by `getEnvironment()` (`lib/env.ts`):

| Environment   | Condition                            | Prefix  |
| ------------- | ------------------------------------ | ------- |
| prod          | `VERCEL_ENV === "production"`        | `prod:` |
| test          | `NODE_ENV === "test"` (Jest sets it) | `test:` |
| dev / preview | everything else                      | `dev:`  |

So the same `KV_REST_API_URL` / `KV_REST_API_TOKEN` are used everywhere and there is nothing to
replicate between instances. **The corollary is the hazard:** any code path that resolves the
environment wrongly, or any script run with the wrong `VERCEL_ENV`, writes into _prod's_ keyspace from a
dev machine. Before running anything that writes KV, echo the resolved environment and the first key it
will touch, and confirm the prefix. `rebuild-dev-kv-from-db.ts` does this itself — it refuses unless
`getEnvironment() === "dev"` — and any future sweeper should follow the same pattern: print the resolved
prefix and every doomed key, and require an explicit `--yes` before deleting.

## Addressing: subjects, not systems

Everything the cache is keyed by is a **subject** — a device or an Area, named by its TypeID:

```ts
type KvSubject =
  | { kind: "device"; id: DeviceId }
  | { kind: "area"; id: AreaId };
```

The integer handle survives only as a _lookup_: the KV layer's public functions still take a handle and
resolve it at the boundary (`lib/kv-subjects.ts`). That module is where the one genuinely subtle rule
lives, and it is worth reading before touching any of this:

> **A handle names up to TWO subjects, and a read must visit both.** `legacy_handles` is a two-column
> compatibility row, so the same integer may name an Area _and_ a device (18 of 22 dev handles do —
> every device gets an area-of-one — and handle 13 is a real Sigenergy device _and_ a 3-member Area).
> Before PR 3 both legs wrote to one `latest:system:N` hash, so that hash _was_ the union.
> `getLatestValues(handle)` therefore reads every leg and merges them, device leg last.
> Writes, by contrast, address the precise subject.

## Key namespaces

### `latest:device:{dv_…}` / `latest:area:{ar_…}` — latest point values

**Type:** Hash. Field = `logicalPath` (`"path/metricType"`), value = a `LatestValue`.

The most recent value of every point, updated in real time as readings arrive. A **device** hash holds
that device's own points; an **Area** hash holds the Area's resolved point set, materialised by the
subscription fan-out (below).

```ts
{
  "source.solar.local/power": {
    value: 5234.5,
    logicalPath: "source.solar.local/power",
    measurementTimeMs: 1731627600000,
    receivedTimeMs: 1731627605000,
    metricUnit: "W",
    displayName: "Solar Power",
    pointReference: "pt_01k9…",   // the source point's TypeID
    sourceSystemId: 6,            // the source DEVICE's integer handle — see below
    sessionId: "0199…",
    sessionLabel: "poll",
  }
}
```

Two persisted fields deserve care, because changing either invalidates entries an older build wrote:

- **`pointReference`** is the source point's `pt_` TypeID. It used to be `"{systemId}.{pointIndex}"`;
  the two grammars are mutually unambiguous, so a stale entry reads as absent rather than being
  mis-parsed.
- **`sourceSystemId`** is still the source device's **integer handle**, deliberately unchanged by the
  keyspace move. It is a payload field, not part of a key; an integer here stays a valid integer, so
  there would be no discriminator for old entries, and `/api/data`'s readings rows put it on the wire
  verbatim. It retires with the handle itself.

**Written by:** `updateLatestPointValue()` (`lib/kv-cache-manager.ts`) — six callers: the
OpenElectricity and Amber adapters, `PointManager`, the HWS recompute, the battery-provenance blend,
and the run-tracking publisher.
**Read by:** `getLatestValues(handle)` / `getLatestValuesForSubject(subject)`
(`lib/latest-values-store.ts`). `/api/data` is the serving consumer.
**TTL:** none. Overwritten on each reading.

### `subscriptions:device:{dv_…}` — subscription registry

**Type:** JSON. Maps a source point to the Areas that subscribe to it, so a reading fans out only to the
Areas that actually want it.

```ts
{
  pointSubscribers: {
    "0199a1…": ["ar_01ka…", "ar_01kb…"],  // source point uuid -> subscriber Area TypeIDs
    "0199a2…": ["ar_01ka…"],
  },
  lastUpdatedTimeMs: 1731627600000,
}
```

- The outer key is a **device**, never an Area: it names the _source_ of a reading, and every point
  belongs to a device (`points.device_id` is `NOT NULL` and FK-backed). An Area is only ever a
  subscriber.
- Inner keys are `points.id` uuids (they were the integer point index until config-v4 slice E PR 2b).
- Values are bare `ar_` TypeIDs. They were `"{areaHandle}.{ordinal}"`; the ordinal half was always
  vestigial (a subscriber's latest hash is keyed by `logicalPath`, and both consumers immediately split
  it back off), so PR 3 dropped it. A ref left by an older build fails `Area.is()` and is ignored, so a
  stale entry degrades to "no subscribers" rather than mis-routing a value.

**Written by:** `buildSubscriptionRegistry()` — a full rebuild from `area_bindings` (curated
multi-device Areas) unioned with `getBindinglessAreaMemberPoints()` (union-default Areas).
**Read by:** `getPointSubscribers()` (inside `updateLatestPointValue`) and `getSubscriberAreaIds()`
(`lib/system-summary-store.ts`).
**Rebuild triggers:** automatically via `refreshAreaServing` on every area/binding mutation; by hand
with `npx tsx scripts/build-subscription-registry.ts`, or `GET /api/devices/subscriptions?action=build`
(admin).
**TTL:** none. Stale entries are garbage-collected by the next rebuild, which deletes any key matching
the family pattern that it did not itself write (a whole-key-string comparison — the old code parsed the
id back out with a `(\d+)` regex, which cannot match a TypeID).

### `system-summaries` — one hash for the whole environment

**Type:** Hash. Field = a `dv_`/`ar_` subject TypeID, value = a `SystemSummary`.

A pre-aggregated solar/load/battery/grid rollup per subject, so the admin list can render without
reading every point hash. **The key name is unchanged by PR 3; the field names moved off the integer
handle.** For a colliding handle this is a small improvement: a device's field now holds the device's own
aggregate, instead of whichever of the device poll and the Area fan-out wrote the shared integer field
last.

**Written by:** `updateSystemSummary()` (source device, from the poll's own batch) and
`updateSubscriberSummary()` (a subscriber Area, from its own `latest:area:` hash).
**Read by:** `getAllSystemSummaries()` / `getSystemSummary()` — `lib/admin/get-devices-data.ts` and
`GET /api/admin/latest`.

### `oe:sched:device:{dv_…}` — OpenElectricity poll-scheduler state

**Type:** JSON (`OeSchedState`: learned EWMA arrival delay + last-seen interval).

Self-seeding: on a miss, `loadState` re-derives `lastSeenIntervalEndMs` from the newest stored interval
and falls back to the default delay. That is why PR 3 migrated the key rather than leaving it behind —
orphaning it costs at most one mis-timed poll per OE device.

### `username:{username}` — Clerk username cache

**Type:** String (JSON `{ clerkId, lastUpdatedTimeMs }`). Untouched by PR 3.

Lazy-populated on first access, because a Clerk API lookup is ~4–10 s against ~400–500 ms for a KV hit.
Written by `cacheUsernameMapping()`, read by `getUserIdByUsername()`, invalidated by
`invalidateUsernameCache()` / `updateUsernameCache()` (`lib/user-cache.ts`). No TTL — invalidated on a
username change.

## Rebuilding — the only supported way to change a key shape

**KV is disposable: rebuild, never migrate in place.** A key-shape change therefore has a **deploy
step**, and it belongs in the PR body, not in a reviewer's memory:

1. Deploy the new build.
2. `npx tsx scripts/build-subscription-registry.ts` — the registry is a _persisted derived store_ keyed
   off the thing that changed, so nothing fans out until it is rebuilt.
3. Repopulate the latest values: in prod, the next poll cycle does it; in dev/preview, crons are off, so
   run `npm run db:rebuild-dev-kv` (`scripts/utils/rebuild-dev-kv-from-db.ts`, which also runs
   automatically after the 2-hourly DB sync — see [../sync-prod-to-dev.md](../sync-prod-to-dev.md)).
4. Sweep the orphaned old keys. The new key shape is built alongside the old one, never over it, so the
   retired keys survive the rebuild — invisible to every current SCAN pattern, holding stale readings
   forever. Write a one-shot delete-only sweeper scoped to `kvKey()`'s prefix, run it dry first, read the
   list, re-run with `--yes`, then delete the script (git is the archive). The config-v4 Phase 13
   integer→TypeID sweeper (`kv-drop-legacy-integer-keys.ts`) is the worked example — see its history.

Verify by running the same probe before and after and **diffing the inner keys** — a shape change that
half-landed looks like an empty `latest` map, not an error.

## Operations

```ts
import { kv } from "@/lib/kv";
import { latestValuesKeyPattern, subscriptionsKeyPattern } from "@/lib/kv-keys";

await kv.keys(latestValuesKeyPattern()); // this environment only
await kv.keys(subscriptionsKeyPattern());
```

Never interpolate one of these key strings outside `lib/kv-keys.ts`. That module exists because the
builders were previously duplicated — `latest:system:N` in two files, `subscriptions:system:N` in two
others — and a duplicated key builder is a **silent cache split**: change one and miss the other and
writes land under the new key while reads come from the old, with no error anywhere.

```bash
# Clear this environment's latest-values hashes (admin, both kinds)
curl -H "x-claude: true" "http://localhost:3000/api/admin/latest?action=clear"

# Inspect the registry
curl -H "x-claude: true" http://localhost:3000/api/devices/subscriptions

# Latest values for a handle (device leg ∪ area leg)
curl -H "x-claude: true" "http://localhost:3000/api/data?systemId=13&include=readings"
```

## Performance

The store is in Tokyo, so a round trip is ~400–900 ms from a dev machine in Melbourne and ~50–100 ms
from prod in Sydney. It is a real latency component of `/api/data` — `buildSystemPayload` spans it as
`kv` in the `Server-Timing` header. The handle-union read issues its (at most two) hash reads
concurrently, so wall-clock latency is unchanged from the single-hash era.

| Operation                 | Type   | Notes                                       |
| ------------------------- | ------ | ------------------------------------------- |
| `kv.hgetall()`            | Hash   | one latest-values hash                      |
| `kv.hset()`               | Hash   | one point's latest value                    |
| `kv.get()` / `kv.set()`   | String | a subscription-registry entry               |
| `kv.keys()` / `kv.scan()` | Scan   | pattern match within the environment prefix |

## Security

- **Admin-only:** `/api/devices/subscriptions`, `/api/admin/latest`.
- **Share-token aware:** `/api/data` (`requireDashboardAccess`).
- Latest values are user energy data; the registry is config metadata; the username cache maps usernames
  to Clerk ids.
- `KV_REST_API_TOKEN` is read/write. A read-only token exists in Upstash and is not currently wired up;
  prefer it for any monitoring use.
