# Device integrations

> **Status:** current — last verified 2026-06-13.
> A **device** (≡ **system**) is one monitored installation backed by one vendor adapter.
> This folder documents each device integration and the **shared structure** they follow.
> Code lives in `lib/vendors/<vendor>/`; these docs hold the _why_, the invariants, and the
> operational runbook — not the columns (the Drizzle schema and the adapter own those).
>
> The canonical vendor inventory is the table in
> [../architecture/overview.md](../architecture/overview.md#vendor-integration). The data path
> every device feeds into is [../architecture/engine-web-separation.md](../architecture/engine-web-separation.md).

## Anatomy of a device integration

Every adapter is assembled from the same building blocks. A device doc should explain the
device's choice for each.

| #   | Block                  | Where                                                                                         | What it decides                                                                                                                                                                    |
| --- | ---------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Adapter**            | `lib/vendors/<v>/adapter.ts` (extends `base-adapter.ts`)                                      | `vendorType`, `displayName`, `dataSource` (`poll`/`push`/`combined`), `supportsAddSystem`; implements `fetchData`, `shouldPoll`, `testConnection`, `getLastReading`                |
| 2   | **Client**             | `lib/vendors/<v>/client.ts`                                                                   | transport to the vendor API, auth header, typed errors (esp. retryable 429/5xx)                                                                                                    |
| 3   | **Types**              | `lib/vendors/<v>/types.ts`                                                                    | request/response shapes, credentials shape                                                                                                                                         |
| 4   | **Point metadata**     | `lib/vendors/<v>/point-metadata.ts`                                                           | the points the device produces (`physicalPathTail`, `logicalPathStem`, `subsystem`, `metricType`, `metricUnit`, `transform`) + response→reading mapping                            |
| 5   | **Registration**       | `lib/vendors/registry.ts`                                                                     | the string key the system's `vendorType` resolves to                                                                                                                               |
| 6   | **Interval class**     | `lib/vendors/native-intervals.ts`                                                             | **raw** (PG recomputes 5m/1d from raw → receiver `onConflictDoNothing`) vs **5m-native** (vendor sends 5m → receiver UPSERTs, so late revisions heal)                              |
| 7   | **Credentials**        | per-user Clerk (`lib/secure-credentials.ts`) **or** an app-wide env var                       | how the adapter authenticates; the cron credential gate in `app/api/cron/minutely/route.ts` must allow vendors that need no per-user credentials                                   |
| 8   | **Provisioning**       | Add-System UI (`supportsAddSystem`) **or** a seed script                                      | how a `systems` row is created (owner, `vendorSiteId`, `metadata`, `timezoneOffsetMin`)                                                                                            |
| 9   | **Scheduling**         | `pollIntervalMinutes`/`toleranceSeconds` on the base, **or** a custom `shouldPoll`            | when the minutely cron actually polls this system                                                                                                                                  |
| 10  | **Ingest**             | `PointManager` → poll-collector → QStash → `app/api/observations/receive` (single writer)     | `fetchData` returns readings; the base adapter inserts + publishes; the receiver is the only writer of `point_readings`/aggregates. Latest values → KV (`lib/kv-cache-manager.ts`) |
| 11  | **Backfill / history** | online route under `app/api/cron/<v>-backfill` and/or an offline `scripts/<v>-bulk-ingest.ts` | how gaps and historical loads are filled (see the tiered strategy in each device doc)                                                                                              |
| 12  | **Tests**              | `lib/vendors/<v>/__tests__/`                                                                  | unit-test the pure logic (mappers, schedulers); document the live verification runbook                                                                                             |

**Invariants that hold for every device** (see engine-web-separation.md):

- Collection **never** writes the serving store directly. `fetchData` returns readings; the
  queue + receiver materialise them. The receiver is the single writer.
- Every poll is one **session** (UUIDv7), success or failure, for observability.
- Power is Watts, energy is Wh/kWh; other metrics carry an explicit `metricUnit` string
  (free-form — there is no enum). Timestamps are stored as the **interval END**.
- **Ownership / public devices:** a system with `ownerClerkUserId = NULL` is **public** —
  readable by every authenticated user (writable only by admins). It can poll without an owner
  only if its vendor authenticates with an app-wide credential (allow-listed in
  `lib/vendors/ownership.ts`); per-user vendors (Amber, Tesla, Enphase) still require an owner.

## Device doc structure

Each `docs/devices/<vendor>.md` should have, in order:

1. **Status** line + one-paragraph overview (what it imports, which API).
2. **Anatomy** — the table above, filled in with this device's concrete files/choices.
3. **Data model** — the points it produces (and any derived values + their formula/units).
4. **Polling & scheduling** — cadence/latency strategy.
5. **Gap handling & backfill** — the tiered fill strategy (auto-heal → backfill route → bulk).
6. **Operations** — env vars, seed, force-poll, backfill/bulk commands, verification queries.
7. **API gotchas** — anything non-obvious or contradicted by the vendor's own docs.
8. **Status / remaining** — what's not yet done.

## Adding a new device — checklist

- [ ] `lib/vendors/<v>/{adapter,client,types,point-metadata}.ts` (blocks 1–4)
- [ ] Register in `registry.ts`; classify in `native-intervals.ts` (blocks 5–6)
- [ ] Credentials path + cron gate (block 7)
- [ ] Provisioning: Add-System flow or `scripts/seed-<v>-systems.ts` (block 8)
- [ ] Scheduling decided (block 9)
- [ ] Unit tests for pure logic (block 12); `npm run type-check` + `build:local` green
- [ ] `docs/devices/<v>.md` following the structure above
- [ ] Add a row to the vendor table in `architecture/overview.md` and a link in `docs/README.md`

## Devices

- [open-electricity.md](open-electricity.md) — OpenElectricity (NEM) regional emissions
  intensity, spot price, renewable proportion (poll, 5m-native, dynamic cadence).
