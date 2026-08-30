# API

> **Status:** current — last verified 2026-08-01.
> This doc covers **conventions and externally-consumed surfaces** — the things that are contracts,
> or that you cannot infer by reading the route tree. It deliberately does **not** carry a route
> inventory: `find app/api -name route.ts` is the ground truth, and the hand-maintained table this
> replaced had rotted badly (it still listed routes that config-v4 deleted a month earlier).

## Conventions

**Base URLs:** `http://localhost:3000` (dev), `https://liveone.energy` (prod, region `syd1`; the
`liveone.vercel.app` deployment URL also resolves). Per-branch previews get
`*.preview.liveone.energy` automatically — see the `bind-preview` skill.

**Auth modes** (all centralized in `lib/api-auth.ts` — see [authentication.md](authentication.md)):

| Mode             | Mechanism                                                              | Used by                                      |
| ---------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| User             | Clerk session (`requireAuth`)                                          | Dashboard/data endpoints                     |
| Device access    | Clerk session + owner/public check (`requireDeviceAccess`)             | Per-device endpoints                         |
| Dashboard access | Owner ∪ grant ∪ share token (`requireDashboardAccess`)                 | Anything a shared dashboard's cards fetch    |
| Admin            | Clerk session with admin role (`requireAdmin`)                         | `/api/admin/*`                               |
| Cron             | `Authorization: Bearer ${CRON_SECRET}` or admin (`requireCronOrAdmin`) | `/api/cron/*`                                |
| QStash signature | Upstash request signing                                                | `/api/observations/receive`                  |
| Webhook key      | API key in the request body                                            | `/api/push/fusher`, `/api/gush`              |
| Share token      | `?access=<3-word token>`, GET/HEAD only                                | The dashboard page + its read-only data APIs |
| Dev bypass       | `x-claude: true` header (development only)                             | Local API testing — but see the trap below   |

⚠️ **`x-claude` only reaches routes the Clerk middleware lets past.** `requireAuth` honours the
header inside the handler, but `middleware.ts` runs `auth.protect()` at the edge first and rewrites
unauthenticated API calls to a **404**. So `x-claude` works on public-listed routes (`/api/cron/*`)
and 404s on everything else; for those, mint a real session JWT. Both lists live in
`lib/route-matchers.ts`.

**Errors:** JSON `{ "error": "message" }` (optionally `success: false`, `code`, `details`).
Standard status codes: 400/401/403/404/409/412/422/500.

**Timestamps:** Unix epoch UTC (ms unless noted). Time-series responses use the
**OpenNEM v4.1 format** (`network: "liveone"`, series ids like
`liveone.1.source.solar.power.avg`).

**Time-series queries** (`/api/history`, `/api/device/[id]/series`): `interval` = `5m`/`30m`/`1d`;
range via `last=7d` style relative or `startTime`+`endTime` absolute. Range caps per request:
31 days @5m, 13 months @30m and @1d (the caps bound the in-memory 5m densify, not the SQL — see
`validateTimeRange` in the route). `series=` accepts glob patterns (micromatch) matched against
the device-less path.

**Identity on the wire.** Config resources are addressed by **TypeID** (`ar_…`, `db_…`, `pt_…`,
`dv_…`) — the `/api/v4` tree speaks these exclusively. The integer `?systemId=N` handle survives as a
permanent alias so existing links never break; it resolves **device-first**, and an explicit
`?areaId=` is authorized against the Area's own scope. See [data-model.md](data-model.md).

## Externally-consumed surfaces

These have consumers outside this codebase — treat as contracts, change carefully:

- **`POST /api/push/fusher`** (alias `POST /api/push/fronius`) — push webhook for
  Fronius-pusher devices. Body auth (`siteId`, `apiKey`); power, battery, fault fields,
  optional interval energies (Wh). Spec: [../vendors/fronius-push-spec.md](../vendors/fronius-push-spec.md).
- **`POST /api/gush`** — the gusher generic push receiver, fed by the on-site collector
  ([`packages/usher`](../../packages/usher/README.md)) for LAN-only devices (DeepSea). Body
  API-key auth; **idempotent on `(systemId, pointId, measurementTime)`**, which is what makes the
  collector's outage-spool re-sends safe. Wire contract:
  [`@liveone/protocol`](../../packages/protocol/README.md).
- **`POST /api/observations/receive`** — the QStash receiver; **the single writer of
  `point_readings`** ([data-model.md](data-model.md) invariant #1). QStash-signed; idempotent.
  Payload spec: [../observations-qstash-payloads.md](../observations-qstash-payloads.md).
  (`/api/observations/receive-dev` is the dev-loop equivalent, and is **log-only** — it does not
  write the DB.)
- **OAuth callbacks** — `GET /api/auth/enphase/callback`, `GET /api/auth/tesla/callback`
  (registered with the respective vendor developer consoles).
- **`GET /.well-known/appspecific/com.tesla.3p.public-key.pem`** — fetched unauthenticated by Tesla
  to register the partner account. Must be reachable without a redirect.
- **`GET /api/health`** — unauthenticated health check (200/503/500) for uptime monitoring.
- **Share links** — a shared dashboard is `?access=<token>` on the dashboard URL. The token is a
  human-facing 3-word phrase and an unauthenticated capability, so the set of routes it can reach is
  bounded at the edge by `isShareableRoute` and validated in-handler by `requireDashboardAccess`.
  Adding a route to that list is a security decision — see [authentication.md](authentication.md).

## Route families

Where things live, so you know which tree to look in. Within each, read the route files.

| Family                        | What it is                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v4/*`                   | **Config CRUD**, TypeID-addressed: areas (+ `members`, `bindings`, `resolution`, `eligibility`, `default-group`, provenance ops), dashboards (+ `grants`, `shares`, `validate`), devices |
| `/api/data`                   | Live values for one subject (KV-backed) — the serving endpoint for card "now" values                                                                                                     |
| `/api/history`                | All historical series, OpenNEM format, plus `?include=sankey` for the flow matrix. One endpoint for every window                                                                         |
| `/api/device[s]/*`            | Per-device reads (points, series, run-periods) and device management (credentials, location, Tesla commands)                                                                             |
| `/api/admin/*`                | Admin-only: devices, users, sessions, observations/DLQ, storage, latest-value diagnostics, Amber sync, Tesla partner registration                                                        |
| `/api/cron/*`                 | Scheduled jobs; schedules of record are in `vercel.json`. Gated by `CRONS_ENABLED` except with `?force=true`                                                                             |
| `/api/observations/*`         | The QStash receiver (single writer) and its dev twin                                                                                                                                     |
| `/api/push/*`, `/api/gush`    | Inbound push receivers                                                                                                                                                                   |
| `/api/auth/{enphase,tesla}/*` | Vendor OAuth connect/callback/disconnect                                                                                                                                                 |

Two naming notes that trip people up: the **plural** `/api/devices/*` is management and the
**singular** `/api/device/*` is per-device reads (the share-token allow-list depends on exactly this
distinction), and `/api/devices/subscriptions` is the KV subscription registry, not a device list.
