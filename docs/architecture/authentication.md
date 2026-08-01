# Authorization model

> **Status:** current — last verified 2026-08-01.
> This doc holds the **authorization model**: who can read or write what, and where that is decided.
> Clerk _setup_ (env vars, dashboard configuration, credential storage layout) lives in
> [`../clerk-setup.md`](../clerk-setup.md). The functions themselves are in `lib/api-auth.ts` and the
> edge allow-lists in `lib/route-matchers.ts` — both are the source of truth; this explains _why_
> they are shaped as they are.

## The shape of it in one paragraph

Identity is Clerk's. Authorization is ours, and it is deliberately small: a **device** has exactly
one nullable owner and no grant table, so device-level access is owner-or-public. Everything richer
— inviting a person, publishing a read-only link — happens one level up, at the **dashboard**. There
are no area ACLs and no per-point ACLs. Nothing computes access ad hoc; every route goes through
`lib/api-auth.ts`.

## Device ownership

A device's only per-user link is **`devices.owner_user_id`** — one nullable owner. A NULL owner means
the device is **platform-public**: readable by everyone, writable only by admins. That is not an
accident of migration; it is how the OpenElectricity NEM region devices are shared with every user.

There is no per-device grant table. `user_systems` — the pre-Areas `owner`/`viewer` junction — was
dropped in migration **0045** (config-v4 Phase 12 slice F) with **no replacement**, because sharing
is per-**dashboard**: `dashboard_grants` (per-person invite) and `share_tokens` (public link), both
enforced by `requireDashboardAccess`. See [areas-and-dashboards.md](./areas-and-dashboards.md) §5.

## The auth helpers

| Helper                   | Answers                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `getAuthContext`         | who is this caller? (`userId`, `isAdmin`, `isCron`, `isClaudeDev`) — the base every other uses |
| `requireAuth`            | is there a signed-in user at all? Returns an `AuthenticatedContext`                          |
| `requireDeviceAccess`    | may this caller read/write this device? Returns a `DeviceAuthContext`                        |
| `requireDashboardAccess` | same question for a dashboard, and **share-token aware** — `userId` may legitimately be null |
| `requireAdmin`           | platform admin only                                                                          |
| `requireCronOrAdmin`     | a `CRON_SECRET` bearer token, or an admin session                                            |

All of them return either the context object or a `NextResponse` error, so every call site reads the
same way:

```typescript
const authResult = await requireDeviceAccess(request, systemId);
if (authResult instanceof NextResponse) return authResult;
const { device, isOwner, canWrite } = authResult;
```

`requireDeviceAccess` takes `{ requireWrite: true }` for mutations. It resolves the integer handle
through `DeviceConfigRegistry.deviceByHandle` and is **strictly for real devices** — the area-view
path is `requireDashboardAccess`'s job.

### Access levels

| Level      | canRead | canWrite | Description                                 |
| ---------- | ------- | -------- | ------------------------------------------- |
| Admin      | ✅      | ✅       | Platform admin                              |
| Owner      | ✅      | ✅       | Device owner (`owner_user_id`)              |
| Public     | ✅      | ❌       | Ownerless device (`owner_user_id IS NULL`)  |
| Claude dev | ✅      | ❌       | `x-claude` header, development only         |

Exactly: `canRead = isAdmin || isClaudeDev || isOwner || isPublic` and `canWrite = isAdmin || isOwner`.

There is no **Viewer** level. It was a fourth read term probing `user_systems`, removed with that
table in migration 0045 — it held 0 rows on prod and never conveyed write, so `canWrite` was
unaffected and `canRead` only narrowed. A dashboard grantee still gets in, via
`requireDashboardAccess`.

### The device-switcher list

`DeviceConfigRegistry.devicesVisibleByUser` (`lib/registry/device-config.ts`) is the one place that
enumerates rather than checks: devices the user **owns**, devices that are **public**, and devices a
**dashboard grant** reaches (via `grantedDeviceScopeForUser`). That third leg used to be an inner
join on `user_systems`; it was re-pointed at `dashboard_grants` rather than deleted, because it is
load-bearing for Vercel preview — preview authenticates against the live prod Clerk instance while
`liveone-dev`'s config is reowned to the dev id.

## The edge: what Clerk middleware decides before a handler runs

`middleware.ts` runs `auth.protect()` on everything **not** allow-listed, and the two lists live in
`lib/route-matchers.ts`. Read that module before touching any of this; the reasoning is subtle in
three places.

**1. The public allow-list is for self-authenticating endpoints.** `/api/cron/*` (CRON_SECRET),
`/api/push/*` and `/api/gush` (body API key), `/api/observations/*` (QStash signature),
`/api/auth/*` (the vendor OAuth redirect carries no Clerk session), `/api/health`, and the Tesla
`.well-known` public key. These do not skip auth — they authenticate differently, and the handler
enforces it.

**2. The `/api/v4/areas/*` public entries are surgical on purpose.** Three specific suffixes
(`recompute-provenance`, `provenance-summary`, `by-handle/*`) are listed so a headless CRON_SECRET
call reaches the handler instead of being 404'd at the edge. They are written as exact suffixes
rather than a subtree precisely so the sibling mutation routes — `POST /api/v4/areas`,
`PATCH`/`DELETE /api/v4/areas/{id}`, `PUT …/members`, `PUT …/bindings` — stay Clerk-gated. Widening
that pattern to `/api/v4/areas/(.*)` would silently expose the whole config-write surface.

**3. The share-token bypass is fail-closed and read-only.** A `?access=<token>` link cannot be
validated in middleware — the edge runtime has no Postgres — so the edge does a *presence-only*
check and honours it under three simultaneous conditions: the method is **GET or HEAD**, the route is
in `isShareableRoute`, and a token is present. Everything else still hits `auth.protect()`. The
token is then really validated downstream by `requireDashboardAccess`.

`isShareableRoute` is therefore a security boundary, not a convenience list: it bounds where a
stray or forged token could possibly land. It currently holds the dashboard page, `/api/data`,
`/api/history`, `/api/device/*`, and exactly one `/api/v4` route (`…/provenance-daily`). Note the
trailing slash on `/api/device/(.*)` — it matches the singular per-device reads but **not** the
plural `/api/devices` management tree. **Add a route only after confirming its handler validates the
token via `requireDashboardAccess` and exposes nothing beyond the dashboard's scope.**

⚠️ **The `x-claude` consequence.** `x-claude: true` is honoured inside `requireAuth`, but the
middleware runs first and rewrites unauthenticated API calls to a **404**
(`x-clerk-auth-reason: protect-rewrite`) before the handler ever sees the header. So `x-claude`
reaches public-listed routes and 404s on everything else. For those, mint a real session JWT
(`scripts/utils/get-test-token.ts`; it expires in ~60s, so mint it in the same command that uses it).

## Cron protection

Cron endpoints use `requireCronOrAdmin` — a `Authorization: Bearer ${CRON_SECRET}` header or an admin
session — and record which one they got, since the session row's cause differs:

```typescript
const authResult = await requireCronOrAdmin(request);
if (authResult instanceof NextResponse) return authResult;
const sessionCause = authResult.isCron ? "CRON" : "ADMIN";
```

Schedules live in `vercel.json`. Separately, `CRONS_ENABLED` must be exactly `"true"` for a scheduled
run to do anything — it is unset in dev and preview so they never double-poll vendors. Admin,
`x-claude` and `?force=true` bypass that kill-switch.

## Vendor credentials

Vendor credentials live in **Clerk private metadata** under the owning user, never in the database
(locked decision, 2026-06-06). Private metadata is server-side only, encrypted at rest by Clerk, and
isolated per user. This was reconsidered during the engine/web split design and deliberately kept —
see [engine-web-separation.md](engine-web-separation.md) §3. The read path is
`getSystemCredentials` (`lib/secure-credentials.ts`); the per-vendor layout is in
[`../clerk-setup.md`](../clerk-setup.md).

One consequence worth knowing: because credentials are per-**owner**, a job that fetches on a user's
behalf needs that user's Clerk record. Coverage repair runs against prod Clerk for exactly this
reason, even in a dev run.

## Admin

Admin is a Clerk session claim (`isPlatformAdmin`), with fallbacks to `ADMIN_USER_IDS` and a Clerk
API lookup (`isUserAdmin`, `lib/auth-utils.ts`). The claim exists for latency, not convenience: the
API-lookup fallback is a network round-trip on every admin check, and it shows up as the `admin` span
in `Server-Timing`. If you see that span costing real time, the session claim isn't configured — see
[`../clerk-setup.md`](../clerk-setup.md).
