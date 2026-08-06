# @liveone/protocol

> **Status:** current.

The **gusher push wire contract** — the only thing the LiveOne app and the
[usher](../usher/README.md) share. Type-only, private to the monorepo, consumed as TypeScript source
(no build step).

Two types, both in [`src/index.ts`](src/index.ts), which is the source of truth:

- **`PushReading`** — one **self-describing** point reading. It carries its own point metadata
  (`metricType`, `metricUnit`, `logicalPathStem`, `subsystem`, `transform`), which is what lets the
  receiver accept a device type it has never heard of without a schema change.
- **`GushRequestBody`** — the `POST /api/gush` body: who is pushing (`vendorSiteId` + `apiKey`), what
  to do (`action: "test" | "store"`), and the batch.

```jsonc
{
  "vendorSiteId": "sheephouse",
  "apiKey": "gk_…",
  "action": "store",
  "sessionLabel": "musher/1754438400000",
  "measurementTime": "2026-08-06T00:00:00.000Z",
  "readings": [
    {
      "physicalPathTail": "engineRpm",
      "value": 1500,
      "metricType": "speed",
      "metricUnit": "rpm",
      "logicalPathStem": "generator",
      "subsystem": "generator",
    },
  ],
}
```

## Both ends of the wire

|              |                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| **Sender**   | `packages/usher/core/pusher.ts` — retry/backoff, and the outcome that decides whether a batch is spooled |
| **Receiver** | `app/api/gush/route.ts` (the LiveOne app) — auth, then the normal poll pipeline                          |

## Two properties worth knowing

- **Idempotency.** The receiver deduplicates on `(systemId, pointId, measurementTime)`. This is what
  makes it safe for the usher to re-send a spooled batch after an outage, possibly more than once.
  It is a load-bearing guarantee, not an implementation detail — see
  [the durability model](../usher/docs/architecture.md#the-durability-model).
- **The boundary rule.** The usher must not import the app's `@/lib` at runtime; only these wire
  types cross. `lib/push/types.ts` in the app re-exports them so existing importers keep working.
