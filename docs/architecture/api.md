# API

> **Status:** current — last verified 2026-06-10.
> This doc covers **conventions and externally-consumed surfaces**. The route inventory below
> is hand-refreshed from `app/api/**`; a generation script that rebuilds it from the route
> tree is **COMING SOON** — until then, `find app/api -name route.ts` is the ground truth.

## Conventions

**Base URLs:** `http://localhost:3000` (dev), `https://liveone.vercel.app` (prod, region `syd1`).

**Auth modes** (all centralized in `lib/api-auth.ts` — see [authentication.md](authentication.md)):

| Mode             | Mechanism                                                              | Used by                         |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------- |
| User             | Clerk session (`requireAuth`)                                          | Dashboard/data endpoints        |
| System access    | Clerk session + grant check (`requireSystemAccess`)                    | Per-system endpoints            |
| Admin            | Clerk session with admin role (`requireAdmin`)                         | `/api/admin/*`                  |
| Cron             | `Authorization: Bearer ${CRON_SECRET}` or admin (`requireCronOrAdmin`) | `/api/cron/*`                   |
| QStash signature | Upstash request signing                                                | `/api/observations/receive`     |
| Webhook key      | `siteId` + `apiKey` in body                                            | `/api/push/fusher`              |
| Share token      | 3-word token in path                                                   | `/api/share-tokens/[token]`     |
| Dev bypass       | `x-claude: true` header (development only)                             | Anything, for local API testing |

**Errors:** JSON `{ "error": "message" }` (optionally `success: false`, `code`, `details`).
Standard status codes: 400/401/403/404/409/500.

**Timestamps:** Unix epoch UTC (ms unless noted). Time-series responses use the
**OpenNEM v4.1 format** (`network: "liveone"`, series ids like
`liveone.1.source.solar.power.avg`).

**Time-series queries** (`/api/system/[id]/series`, `/api/history`): `interval` = `5m`/`30m`/`1d`;
range via `last=7d` style relative or `startTime`+`endTime` absolute. Range caps: 7.5 days @5m,
30 days @30m, 13 months @1d. `series=` accepts glob patterns (micromatch).

## Externally-consumed surfaces

These have consumers outside this codebase — treat as contracts, change carefully:

- **`POST /api/push/fusher`** (alias `POST /api/push/fronius`) — push webhook for
  Fronius-pusher devices. Body auth (`siteId`, `apiKey`); power, battery, fault fields,
  optional interval energies (Wh). Spec: [../vendors/fronius-push-spec.md](../vendors/fronius-push-spec.md).
- **`POST /api/observations/receive`** — the QStash receiver; **the single writer of
  `point_readings`** ([data-model.md](data-model.md) invariant #1). QStash-signed; idempotent.
  Payload spec: [../observations-qstash-payloads.md](../observations-qstash-payloads.md).
  (`/api/observations/receive-dev` is the dev-loop equivalent.)
- **OAuth callbacks** — `GET /api/auth/enphase/callback`, `GET /api/auth/tesla/callback`
  (registered with the respective vendor developer consoles).
- **`GET /api/health`** — unauthenticated health check (200/503/500) for uptime monitoring.
- **`GET /api/share-tokens/[token]`** — view-only shared dashboards; tokens are
  unauthenticated capability URLs.

## Route inventory

Hand-refreshed 2026-06-10 (generation script COMING SOON).

### Data & user (Clerk auth)

| Route                                                                | Purpose                                                                                                                                                                    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/system/[id]/points`                                        | List active points (`?short=true` for paths only)                                                                                                                          |
| `GET /api/system/[id]/points/latest` · `GET /api/system/[id]/latest` | Latest values (KV-backed)                                                                                                                                                  |
| `GET·PATCH /api/system/[id]/point/[pointId]`                         | Point detail / update user-settable fields                                                                                                                                 |
| `GET /api/system/[id]/series`                                        | Time-series, OpenNEM format                                                                                                                                                |
| `GET /api/system/[id]/generator-events`                              | ⚠️ Known hack — unbounded history fetch + N+1 queries; see [../deferred/generator-events-rewrite.md](../deferred/generator-events-rewrite.md)                              |
| `GET /api/history`                                                   | Historical series (composite + non-composite paths; unification deferred — see [../deferred/history-api-unification-plan.md](../deferred/history-api-unification-plan.md)) |
| `GET /api/data`                                                      | Legacy combined latest+history payload (Selectronic-era dashboard)                                                                                                         |
| `GET·POST /api/systems`, `GET /api/systems/subscriptions`            | Create/list systems; composite subscription registry                                                                                                                       |
| `GET /api/vendors`                                                   | Available vendor types                                                                                                                                                     |
| `POST /api/test-connection`, `POST /api/setup`                       | Setup wizard                                                                                                                                                               |
| `GET·PUT /api/user/preferences`                                      | User preferences                                                                                                                                                           |
| `GET·POST·DELETE /api/share-tokens`, `/api/share-tokens/[token]`     | Share-link management                                                                                                                                                      |
| `/api/auth/{enphase,tesla}/{connect,callback,disconnect}`            | Vendor OAuth flows                                                                                                                                                         |
| `GET /api/auth/check-admin`                                          | Admin check for UI                                                                                                                                                         |
| `POST /api/enphase-proxy`                                            | CORS proxy to Enphase API                                                                                                                                                  |

### Admin (`requireAdmin`)

| Route                                                                                                | Purpose                                                           |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `/api/admin/systems` + `[systemId]/{settings,admin-settings,composite-config,status,point-readings}` | System management                                                 |
| `/api/admin/users`, `/api/admin/user/[userId]/points`                                                | User management; per-user point catalogue                         |
| `/api/admin/sessions`, `[sessionId]`, `filter-options`                                               | Poll-session observability                                        |
| `/api/admin/observations/{dlq,info,messages,stats}`                                                  | Queue + outbox observability                                      |
| `/api/admin/point/[systemId.pointId]/readings`                                                       | Per-point reading inspection                                      |
| `/api/admin/latest`                                                                                  | Latest-values cache diagnostics                                   |
| `/api/admin/storage`                                                                                 | DB storage stats                                                  |
| `/api/admin/amber-sync`                                                                              | Amber audit/sync ([../amber-sync-plan.md](../amber-sync-plan.md)) |
| `/api/admin/sync-database`                                                                           | Vendor→DB historical sync (SSE progress)                          |

### Cron (`requireCronOrAdmin`; schedules in `vercel.json`)

| Route                                | Purpose                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `GET /api/cron/minutely`             | Poll active systems (per-vendor smart schedules; dev params `systemId`, `force`, `date`)                             |
| `GET·POST /api/cron/daily`           | Daily aggregation at 00:05 (actions: `aggregate`/`regenerate`/`delete`; date ranges via `date`/`start`+`end`/`last`) |
| `GET /api/cron/relay-outbox`         | Drain `observations_outbox` → QStash (Phase 4)                                                                       |
| `GET /api/cron/monitor-observations` | Queue/outbox health monitoring                                                                                       |
| `GET /api/cron/db-stats`             | DB stats snapshots                                                                                                   |

### Dev/test only

`/api/observations/receive-dev`, `/api/test/cache`.
