# Ops CLI: queue control, area wiring, and vendor sync

**Status:** in progress · raised 2026-09-09, out of the ingest stall of the same day

**Landed:** all three. §1 `liveone queue` (status/pause/resume/parallelism, plus `timing` and
`outbox`, which this doc did not anticipate), §2 `liveone area devices` + `liveone area role`, and
§3 `liveone sync`.

## Why

Three times on 2026-09-09 the only way to do a routine operation was to drive a logged-in browser
session by hand, because the capability exists **only** behind a Clerk-gated `/api/admin` route with
no CLI path:

1. **Backfilling a new Amber device** — `POST /api/admin/amber-sync`. No CLI verb exists for any
   vendor sync.
2. **Wiring the new area** — `PUT /api/v4/areas/{id}/bindings`, to bind the battery/grid roles.
3. **Diagnosing a 50-minute ingest stall** — `observations/info|stats|dlq`. The queue could be
   *observed* to be wedged and there was **no way to act on it**: `parallelism` is Upstash-side and
   the app exposes no setter at all.

(3) is the sharp one. During a live incident the operator could see the problem and could not touch
it. That is the gap this plan closes, in that order.

## Scope and order

### 1. ✅ `liveone queue` — the incident-time domain (do first)

```
liveone queue status                     # paused, lag, parallelism — the one-line health read
liveone queue stats [--window 24h]       # per-minute ingest rate, last ingest, outbox backlog
liveone queue dlq [--limit N]            # dead letters
liveone queue messages [--limit N]       # what is waiting, oldest first
liveone queue pause | resume             # (writes)
liveone queue parallelism [<n>]          # getter with no arg; setter with one  (writes)
```

`status` must surface the number that actually diagnosed the incident — **minutes since last
ingest** — not just `lag`. A growing `lag` is ambiguous (busy vs stalled); `lastIngestedAt` aged
against `now` is not. Have `status` exit **1 (findings)** when the stall exceeds a threshold, so it
composes into a check.

- `pause`/`resume` already exist behind `POST /api/admin/observations/info`.
- **`parallelism` already exists too** — `POST /api/admin/observations/info` with
  `{action: "set-parallelism"}` — it was simply unreachable from a CLI token, which is the whole gap.
  Shipped as `PATCH /api/v4/queue`.
- 🛑 Under Flow Control (see `ingest-head-of-line-hardening.md`) `parallelism` must be set with
  `flowControl.pin`, not passed per-publish: an unpinned value is silently overridden by the next
  published message, which would make an operator's incident-time change quietly revert.

### 2. ✅ `liveone area devices` and `liveone area role` — rename as they land

The two area sub-resources are already unreachable by CLI token, so they arrive together. Take the
opportunity to drop the table names from the operator vocabulary:

| Route | Today's noun | CLI verb | What it actually is |
| --- | --- | --- | --- |
| `PUT …/members` | "members" | `area devices add\|remove\|set` | which **devices** are in the area (`area_members`) |
| `PUT …/bindings` | "bindings" | `area role set\|clear\|list` | which **point** fills an area's `(role, metric)` slot, at what priority |

🛑 **A binding is not point metadata.** It is *area-scoped role resolution*: "in **this area**, the
`grid/rate` slot is filled by **this point**". The same point can be bound in one area and unbound in
another; the point itself is untouched. Point metadata — units, display precision, labels — is the
display registry, a different system. Naming it `role` keeps it aligned with `lib/roles/registry.ts`
and with `GET …/resolution`, which already reports "what resolved and how".

Ordering is enforced server-side and the CLI should surface it: a bound point's device must already
be a member, so `area devices` populates the pool and `area role` picks within it.

**As shipped**, with three things the sketch above did not anticipate:

- 🛑 **The routes are full replace; the verbs are incremental.** `PUT …/members` and
  `PUT …/bindings` each take the whole collection. An operator thinks "bind `grid/rate` to these
  three points", so every writer reads the current collection, changes one thing, and PUTs it all
  back. Getting that wrong does not error — it deletes everything the caller did not mention. Hence
  `rewriteSlot` (exported and tested directly, not reimplemented in the test) and a diff on every
  write: `bindings: 12 → 15  (12 kept, 3 added, 0 removed)`. The kept count is the assertion.
- **`role set` takes the whole slot, priority = argument order.** A `(role, metric)` slot is a
  fallback CHAIN (`grid/rate` is export, import, spot), so setting it one point at a time would mean
  three read-modify-write round trips to express one intent.
- **A point ref may need its device.** In a composite area the same `logicalPath` routinely exists on
  two members — Kutis and the Amber account both offer `bidi.grid.export/energy` — so a bare path
  that matches more than one is REFUSED, naming both, rather than resolved by sort order.

`area devices remove` names the bindings a shrink would destroy before doing it, and loads the point
pool specifically to be able to (`replaceMembers` deletes a departing member's bindings, and a
warning that cannot fire reads as "nothing to lose").

### 3. ✅ `liveone sync` — one shape for every syncable vendor

```
liveone sync <device> --start YYYY-MM-DD --end YYYY-MM-DD [--action usage|pricing|both] [--apply]
```

Per-vendor differences belong in the adapter, not the caller:

- **Chunking to the vendor's real limit.** Amber caps `/usage` and `/prices` at **7 days**
  (`"Range requested is too large. Maximum 7 days."`) while `/api/admin/amber-sync` validates
  `days ≤ 30` — so any call in 8–30 fails with an opaque `422`. The caller should never have to know
  this number.
- **Chunking to a safe MESSAGE size**, and **reporting rows RECEIVED rather than published**. Both
  are pipeline properties that bind every producer, so they are specified once in
  `ingest-head-of-line-hardening.md` (secondary fixes 1 and 3) rather than restated here. `liveone
  sync` is the verb that must *honour* them: it emits the messages, and it is the thing that reported
  ten consecutive "Rows inserted: 1008 / Success: YES" for a backfill that materialised zero rows.

Dry-run by default with `--apply`, like every other writer in `scripts/ops/`.

## Implementation notes

Follow the existing domain pattern exactly — `scripts/ops/<domain>/cli.ts` exporting a
`defineCommand` spec plus a `run<Domain>` dispatcher, wired into `DOMAINS` in `scripts/ops/liveone.ts`
(none of them owns an entrypoint, so they compose). Then:

- Register each new file in **`lib/cli/tiers.ts`** — tier **A** (agent-facing). An unlisted CLI is a
  finding in `npm run check:cli`, not an exemption.
- `npm run cli:reference -- --apply` to regenerate `docs/cli-reference.md`, the per-directory
  `CLI_README.md` and `docs/cli-tools.json`.
- `npm run check:cli:a` must stay green.

### The auth decision this all rests on

Every route above is currently unreachable with a `lo_cli_` token:

- `/api/admin/*` is deliberately outside the allowlist — *"a stray `lo_cli_` bearer can never skip
  the edge on admin, control or vendor routes"* — and `auth.protect()` rewrites to **404** at the
  edge before the handler sees the bearer. Verified: `404` with
  `x-clerk-auth-reason: protect-rewrite, token-invalid`.
- `…/members` and `…/bindings` are outside it too, but for a weaker reason: the matcher comment says
  named segments were admitted one at a time and these were simply not yet *"judged on its own"*.

So pick one, deliberately, and record it:

- **(a)** Add `…/members` and `…/bindings` to `cliTokenRoutes`. They authorize in-handler via
  `loadAreaForOwner`, exactly like `…/derivations`, which is already admitted — this is the
  established pattern and the smallest change.
- **(b)** Give the queue and sync capabilities **v4 routes** that authorize in-handler, rather than
  widening the `/api/admin` bypass. Better fit for the stated rule that admin routes stay
  Clerk-gated, and it is the reason `recompute-provenance` is reachable today.

Recommendation: **(a) for the two area routes, (b) for queue and sync.** That keeps the `/api/admin`
boundary intact while making the incident-time verbs reachable headlessly — which is the whole point.

✅ **(b) was taken, for both.** `/api/v4/queue{,/timing,/outbox}` and `/api/v4/devices/:id/sync` are
enumerated in `cliTokenRoutes` — never a `(.*)` wildcard, so the next verb in either family is not
pre-admitted — and each authorizes in-handler (`requireAdmin`; `requireDeviceAccess` with
`requireWrite`, whose `canWrite` is admin-or-owner and excludes the public-read term, so an
ownerless device is not syncable by a stranger holding a CLI token).

## Verification

- `npm run check:cli:a` green; `npm run cli:reference -- --apply` produces no uncommitted drift.
- `liveone queue status` against prod reproduces the 2026-09-09 reading (lag, parallelism, minutes
  since last ingest) and exits 1 while stalled.
- `liveone area devices set` + `area role set` reproduce, headlessly, the two writes that had to be
  done through the browser for **High Street Kew** (`ar_01m22twc3qf04r9kvk511t0gfw`) — that area is
  the natural fixture, since it is the case that exposed the gap.
- `liveone sync` over a range whose data is known absent, then a serving-store read proving the rows
  are queryable — the check `amber-sync` did not have.

## What building §2 surfaced (input to the next two PRs)

Wiring an area from a terminal meant reading the integrity model properly for the first time. Two
findings are worth carrying forward rather than rediscovering.

### Soft references in `jsonb` have no protection, and fail silently

The declared foreign keys are sound — `points→devices`, `area_bindings→points`,
`derivations.area_id→areas` and `derivations.output_point_id→points` are all RESTRICT, so the
obvious destructive moves are already refused at the database. Every gap is a reference that lives
inside `jsonb` instead, where no constraint can see it:

| Reference | Stored as | On delete of the target |
| --- | --- | --- |
| `derivations.source_points` | `jsonb` uuid refs | dangles — the detector survives and **never fires again** |
| `users.default_dashboard_id` | plain column, **no FK** | dangles — the user lands somewhere broken, days later |
| `dashboards.doc` `area`/`device` refs | `jsonb` TypeIDs | `resolveScope` **silently drops** the unresolvable one |

All three fail the same way: no error, no log, something that quietly stops working. Two have already
happened on prod — a deleted-area ref inside the retired `legacy-share-…` dashboard, and the
landing-page hazard `liveone dashboard delete` now warns about.

🛑 `derived_intervals` CASCADEs from `derivations`, so deleting a detector **destroys its run
history**. That is the one cascade worth pausing over: the history is not reconstructible from the
derivation row, only by recompute from readings.

The intended fix is a shared `assertNotReliedUpon(kind, id)` at the API boundary — 409 with the
dependents NAMED, `?force=true` to override — because only the boundary can see the `jsonb` refs an
FK cannot. It is the same shape as `transferOwnership`'s share-back check: refuse, and say exactly
what would break.

### A run detector cannot live on a composite area, by design

`ensureRunDetector` refuses one with `area-not-probed`:

> This area's own handle names no device, so `capabilitiesForDevice` never probes it — a run
> detector here would be invisible.

So a detector must sit on a device-backed area-of-one, which is why the Kutis EV detector is on
handle 13 and not on the composite that is now the real site. The refusal is correct — it declines
to create something that could never light up a card — but it means run detection is pinned to the
physical layer while everything else about a site has moved to the semantic one.

That is the case for making a detector bind by ROLE and attach to one or more DEVICES, with no area
relationship at all. Scoped as its own change; it is a data-model move, not a CLI one.
