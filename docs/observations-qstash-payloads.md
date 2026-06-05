# What gets pushed into QStash (readings + sessions)

How a poll's data reaches the QStash `observations` queue, and the exact JSON shapes.
Source of truth: `lib/observations/types.ts`, `lib/observations/publisher.ts`,
`lib/observations/session-publisher.ts`, `lib/qstash.ts`.

## TL;DR

A single poll produces **two or more independent QStash messages**, not one combined message:

1. **One readings message** (sometimes more) — published **mid-poll**, _before_ the Turso write,
   by `publishObservationBatch()` (`lib/point/point-manager.ts:637`). It carries an
   `observations[]` array and **no** `session`.
2. **One session message** — published at **poll completion** by `publishSession()` (from
   `session-manager.updateSessionResult()`), _after_ the readings. It carries a `session` object
   and **no** `observations`.

They are separate messages with **no delivery-ordering guarantee** — the consumer can receive the
session before or after the readings that reference it. (This is why `point_readings.session_id`
has no enforced FK today; see the migration plan for the planned co-enqueue change.)

## The envelope — `QueueMessage`

Every message has the same envelope; `observations` and `session` are both optional, so a message
carries one or the other:

```jsonc
{
  "env": "prod", // "prod" | "dev"
  "systemId": 1,
  "systemName": "Home",
  "batchTime": "2026-06-05T14:32:10+10:00", // ISO8601 + system tz offset
  "observations": [
    /* ... */
  ], // present on readings messages
  "session": {
    /* ... */
  }, // present on session messages
}
```

## Readings message (`observations[]`)

A "slew of readings" from one poll is **batched into a single message's `observations` array** —
one element per point read, not one message per reading. Each `Observation`:

```jsonc
{
  "sessionId": 12345, // integer today (Turso-minted); becomes a UUIDv7 string after the session-id migration
  "topic": "liveone/select.live/abc123/battery_soc", // liveone/{vendorType}/{vendorSiteId}/{physicalPathTail}
  "measurementTime": "2026-06-05T14:32:00+10:00",
  "receivedTime": "2026-06-05T14:32:09+10:00",
  "value": 87.4, // number | string (text metrics) | null (errors)
  "interval": "raw", // "raw" -> point_readings | "5m" -> agg_5m | "1d" -> agg_1d
  "debug": {
    // optional, for inspection
    "type": "soc", // metricType
    "unit": "%", // metricUnit
    "pointName": "Battery SoC",
    "reference": "1.7", // {systemId}.{pointIndex}
  },
}
```

Three flavours of readings message, by `interval`:

- **`raw`** — the common case. Selectronic/Fusher polls publish their raw point readings here (via
  `insertPointReadingsRaw`). `value` only; no `agg`.
- **`5m`** — 5-minute aggregates. Published directly by 5m-native vendors that produce no raw
  readings (Enphase, Amber) via `insertPointReadingsAgg5m`. Carries the full `agg` tuple:

  ```jsonc
  "agg": {
    "avg": 1850, "min": 1700, "max": 2010, "last": 1980, "delta": null,
    "valueStr": null, "sampleCount": 5, "errorCount": 0, "dataQuality": "good"
  }
  ```

- **`1d`** — daily aggregates from the nightly cron. Same `agg` tuple, but `valueStr`/`dataQuality`
  are unused (the daily table has no such columns).

For aggregated observations the full `agg` tuple is sent so the Postgres mirror is full-fidelity
rather than collapsing everything into the single `value` field. Raw observations omit `agg`.

## Session message (`session`)

Published once, at poll completion, after `updateSessionResult` fills in the outcome:

```jsonc
{
  "sessionId": 12345,
  "sessionLabel": "a1b2", // nullable; e.g. deployment-id suffix
  "cause": "CRON", // CRON | ADMIN | USER | PUSH | ...
  "started": "2026-06-05T14:32:00+10:00",
  "durationMs": 9300,
  "successful": true, // true | false | null (pending)
  "errorCode": null,
  "error": null,
  "response": {
    /* full vendor response, JSON */
  },
  "numRows": 42,
  "startTime": "2026-06-05T14:32:00+10:00", // when the session row was created
}
```

Note the session is created (pending, `successful: null`) at poll **start** and only **published**
after it completes — so its message necessarily trails the readings messages it owns.

## Worked example — one poll, a slew of readings + a session

For a poll of system 1 that reads 42 points and succeeds, QStash receives, in order of publish
(not guaranteed order of delivery):

1. **Readings message** — one envelope whose `observations` array holds 42 `raw` entries, all
   stamped with the same `sessionId`. (Published before the Turso insert.)
2. **Session message** — one envelope with the `session` object (`numRows: 42`, `successful: true`).

If the poll reads enough points to exceed a batch, `insertPointReadingsRaw` may be called more than
once, producing more than one readings message — each a self-contained envelope.

## Transport mechanics

- **Queue:** `observations` (production) / `observations-dev` (development) — `lib/qstash.ts:15`.
- **Publish:** `qstash.queue({ queueName }).enqueueJSON({ url, body })` where `body` is the
  `QueueMessage`. No-ops silently if `OBSERVATIONS_QSTASH_TOKEN` is unset.
- **Receiver URL:** the stable public domain `https://www.liveone.energy/api/observations/receive`
  (prod) or `…/receive-dev` (dev). Must be a public custom domain — a `*.vercel.app` per-deployment
  URL is gated by Deployment Protection (401) and QStash can't pass it.
- **Delivery:** QStash POSTs each message to the receiver and signs it; the receiver verifies the
  signature, writes to Postgres, and **returns 500 on any failure so QStash retries** (at-least-once
  delivery — handlers must be idempotent).

## Planned change (migration context)

Under the Postgres-primary migration, the readings message will additionally **carry the pending
session stub**, and the receiver will insert the session before the readings in one transaction —
so a session row is always present when its readings land, enabling a real
`point_readings.session_id → sessions.id` foreign key. Session ids also become app-generated
**UUIDv7** strings. Until that ships, the two-independent-messages behaviour above is current.
