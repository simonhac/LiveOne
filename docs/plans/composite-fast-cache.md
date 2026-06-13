# Plan: instant composite cache refresh on mapping change

> **Status:** proposed — not started (drafted 2026-06-13). Captures the "make the EV/Tesla
> card appear the instant its point is mapped into a composite" work. A prototype of all
> three changes below was written and verified against live data, then reverted — this doc
> is the record so it can be picked up later. No code currently ships this behaviour.

## Why

When you add a point to a composite system's mappings (e.g. mapping the Tesla **Tez**
system's `ev.battery/soc` into **Kinkora Unified**), the new dashboard card does _eventually_
appear — but only after the source system's **next poll** (up to ~5 minutes for Tesla),
and then only after the dashboard's React Query refetch interval (~30 s). The expectation
is that it shows up **immediately on save**.

### How composite latest-values actually work

The dashboard's tiles are gated on the presence of points in the composite's latest-values
cache. The Tesla card specifically:

```tsx
// app/components/cards/SystemPowerCards.tsx
const hasTeslaData = getPointValue("ev.battery/soc") !== null;   // line ~511
...
{hasTeslaData && <TeslaSmallCard ... />}                          // line ~729
```

`getPointValue` reads the map returned by `/api/data?systemId=8` →
`getLatestPointValues(8)` → the KV hash `latest:system:8`.

A composite never polls; its cache is populated **incrementally** by propagation. Each time
a _source_ point gets a reading, `updateLatestPointValue` (`lib/kv-cache-manager.ts`) looks
up the **subscription registry** (`subscriptions:system:<src>`) to find which composites
subscribe, and copies the value into each composite's `latest:system:<composite>` hash,
keyed by the source point's **logical path** (e.g. `ev.battery/soc`).

### The gap

Saving the mapping (`PATCH /api/admin/systems/[systemId]/composite-config`) calls
`buildSubscriptionRegistry()`, so **future** source readings will propagate. But nothing
backfills the composite cache with the source points' **current** values, and the dashboard
data query is never invalidated. Hence the double delay:

1. **KV:** the value isn't in `latest:system:8` until the source's next poll (~5 min worst
   case for Tesla).
2. **UI:** even once it's in KV, the dashboard `["data", systemId]` query waits for its
   ~30 s refetch interval (it's paused while the modal is open).

## Proposed fix (three changes)

### 1. Backend backfill — `lib/kv-cache-manager.ts`

Add `rebuildCompositeLatestValues(compositeSystemId)`:

- Load the composite's `metadata.mappings` (v2) directly from Postgres
  (`requirePlanetscaleDb()`, not `SystemsManager`, to read post-update metadata).
- Group the mapped point refs (`"<sys>.<pointId>"`) by source system.
- For each source system, `hgetall latest:system:<src>` and keep entries whose stored
  `pointReference` is in the mapped set, keyed by their logical path (matching exactly how
  `updateLatestPointValue` writes the composite hash).
- `kv.del(compositeKey)` then `kv.hset(compositeKey, values)` — a **full replace**, so it
  also clears values for points that were **removed** from the mapping. The cache becomes an
  exact mirror of the current config.

Data-semantics check (verified live): source hash stores `"pointReference":"10.1"` and the
mapping stores `"10.1"` — identical decimal `sys.pointId` form, so the match is exact.

### 2. Call it on save — `app/api/admin/systems/[systemId]/composite-config/route.ts`

In the `PATCH` handler, right after `buildSubscriptionRegistry()` (same best-effort
try/catch — never fail the request on a cache hiccup):

```ts
await buildSubscriptionRegistry();
await rebuildCompositeLatestValues(systemId);
```

### 3. Refetch the dashboard — `components/SystemSettingsDialog.tsx`

The settings modal overlays the dashboard, which keeps the `["data", systemId]` query
mounted (paused). On a successful save where the composite was changed, invalidate it so it
refetches immediately:

```ts
// capture before dirty flags reset
const compositeChanged = isCompositeDirty;
...
if (compositeChanged && systemId != null) {
  invalidateSystem(queryClient, systemId);   // from "@/lib/queries"
}
```

`invalidateSystem` is the existing helper used after Poll-Now / Amber-Sync (the React Query
replacement for the old dashboard-refresh event bus). `invalidateQueries` refetches active
(mounted) observers immediately regardless of `staleTime`/paused interval, so the card
appears the moment the modal closes.

## Net effect

Add (or remove) a composite mapping → Save → the composite's KV cache is rebuilt server-side
and the dashboard refetches → the affected card (e.g. Tesla EV) appears/disappears at once,
no poll wait, no manual reload.

## Verification (when implemented)

- `npm run type-check` clean.
- On **Kinkora Unified**: remove the EV mapping + Save → card vanishes immediately; re-add +
  Save → card reappears immediately.
- Confirm `latest:system:8` in KV gains/loses the `ev.*` keys on save (not just after the
  next Tesla poll).

## Notes / risks

- The full `del`+`hset` replace introduces a sub-millisecond window where the composite cache
  is empty; only happens on a manual admin save, so negligible. If ever a concern, diff the
  key set and only delete removed keys instead.
- The composite cache is written **only** by propagation today, so a rebuild from current
  source values is equivalent to its steady state after every source has polled once — safe
  to replace wholesale.
- A unit test belongs in the **integration** suite (real KV); the mocked
  `kv-cache-manager.test.ts` models the `.where().orderBy()` query shape, whereas the new
  function awaits `.where()` directly.
