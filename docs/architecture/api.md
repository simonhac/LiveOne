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
| Calendar feed token | `?token=<20-char token>`, GET/HEAD only (`validateCalendarToken`)   | `/api/v4/areas/:id/calendar.ics` only        |
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
- **Calendar feeds** — `GET /api/v4/areas/:id/calendar.ics?token=<token>` is a subscribable `.ics`
  of an area's scheduled automations. Same shape and the same deliberate security decision as a
  share link: a calendar client fetches it unattended for years and has no way to sign in, so the
  URL is the entire credential. Bounded at the edge by its OWN matcher (`isCalendarFeedRoute`, not
  `isShareableRoute` — different table, different predicate) and validated in-handler, which also
  checks the token belongs to the area in the path. See [calendar.md](../calendar.md).

## Route families

Where things live, so you know which tree to look in. Within each, read the route files.

| Family                        | What it is                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v4/*`                   | **Config CRUD**, TypeID-addressed: areas (+ `members`, `bindings`, `resolution`, `eligibility`, `default-group`, provenance ops), dashboards (+ `grants`, `shares`, `validate`), devices |

### Admin is a privilege you invoke, not a state you are in

🛑 **Being an admin and acting as one are different, and the default is not acting.** An admin
browsing the app or running the CLI is answered exactly as any other user would be; reaching across
owners is something you say, once, and see reported back to you. A privilege that is always on is one
you cannot audit and cannot forget to use.

The carrier is the request header **`x-liveone-admin: 1`**, surfaced as `AuthContext.actingAsAdmin`
(`lib/api-auth.ts`). It is gated on the caller actually being an admin, so the header alone grants
nothing — setting it is a REQUEST to use a privilege, never a claim to have one. A header rather than
a query parameter because "act as admin for this request" is a property of the request, not a
selector on one resource, so every verb carries it without each route parsing it.

| surface | how you invoke it |
| --- | --- |
| operator CLI | `--admin` on any API verb. The `target:` line then reads `(AS ADMIN — fleet-wide)` instead of `(admin, not in use)`, so a fleet-wide answer is always traceable to a request for one. A non-admin passing it is refused (exit 3), never silently narrowed. |
| web app | not yet wired — see below |

What it widens today: `listReadableAreas` and `devicesVisibleByUser`, and therefore
`GET /api/v4/areas`, `GET /api/v4/devices`, and `GET /api/v4/areas/{id}` + its sub-resources through
`findReadableArea`. That last one is what removes a real asymmetry — `loadAreaForOwner` has always
granted an admin WRITE on any area, so without it an admin could `PATCH` an area that `GET` on the
same id refused: **write access to something you cannot read.**

Two deliberate non-participants:

- **`requireAdmin`** (the `/api/admin/*` surfaces) keeps using `isAdmin`, not `actingAsAdmin`.
  Navigating to an admin-only route IS the explicit act; a second signal there would be ceremony.
- **`POST /api/v4/dashboards {seedArea}`** and `checkDocRefsReadable` validate a document's refs
  against the document's **owner**, not the caller — so seeding from an area an admin can see but does
  not own would mint a doc that fails its own later edit check. Admin widens what you may address,
  not what you may embed.

🛑 **The rule as it stands: the ENUMERATING reads are opt-in, writes are not** — and the split is a
staging decision, not a principle.

The reads converted are the **enumerating** ones and the **area aggregate**: `listReadableAreas`,
`devicesVisibleByUser`, and therefore `GET /api/v4/areas`, `GET /api/v4/devices`, and
`GET /api/v4/areas/{id}` + its sub-resources through `findReadableArea`.

⚠️ **Not every cross-owner read.** `requireDeviceAccess`'s `canRead` and
`GET /api/v4/areas/by-handle/{handle}` still use plain `isAdmin`, so without the header an admin can
be refused by `GET /api/v4/devices/{id}` and still read that device's `/config` or `/sessions`. That
is an inconsistency, not an escalation — those privileges are pre-existing and unchanged — but it is
real and it is why this section says "the reads converted" rather than "all reads".

Every cross-owner **write** — `requireDeviceAccess`'s `canWrite`, `loadAreaForOwner`'s gate,
`resolveMemberDeviceRefs` / `assertDevicesRehomable`, `PATCH /api/v4/devices/{id}` — still uses plain
`isAdmin` and is unconditional, exactly as before. Uniform: no write route is the odd one out.

Moving the write side onto the opt-in is the right end state and should be **one** change, because a
half-converted write surface is worse than either end — an admin would be able to reach a route and
then be refused halfway through it, for reasons that differ per route. The web app's "act as admin"
toggle belongs with it: until that exists there is no way for a browser to send the header, so
converting writes first would lock admins out of the UI.
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
