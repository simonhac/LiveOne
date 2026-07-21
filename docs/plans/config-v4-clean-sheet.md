# Config v4 — the clean-sheet config model

> **Status: PROPOSAL** — for review; no implementation, no migrations. Written 2026-07-21.
>
> **This document supersedes** — they inspired it, they do not constrain it:
> [identity-address-split-and-labels.md](identity-address-split-and-labels.md) (absorbed: `points.id`
> *is* the identity; labels stay a deferred seam), [info-producers-consumers.md](info-producers-consumers.md)
> (absorbed: per-slot deterministic resolution with priority, bind-time shape validation, config
> producers, availability — see §4.3–4.4), and
> [home-assistant-comparison.md](../architecture/home-assistant-comparison.md) (the HA-relationship
> decisions now live here). It also overturns parts of
> [areas-and-dashboards.md](../architecture/areas-and-dashboards.md): the "Not planned — retiring
> integer system addressing" section and the lazy-areas policy.

## 1. Context & motivation

The current persistence for dashboards, areas, device config and wiring was reached by iteration:
per-system dashboards → composite systems → areas-backed virtual systems → v3 composition
dashboards. Each step was shippable and each dragged something forward. The result works, but a
clean sheet would not produce it. The accumulated warts:

- **The polymorphic integer handle.** `areas.legacy_system_id` is the address for everything —
  `/api/data?systemId=`, KV keyspaces, point resolution, run periods, capabilities, descriptor
  `deviceSystemId`. An integer ≥1,000,000 means "synthetic area", below means "real device", and
  nothing in the type system knows which. This is the standing type-confusion bug factory.
- **One word, three meanings.** "System" means physical device, synthetic composite, and logical
  area depending on the call site.
- **Duplicated placement.** Timezone + location live on both `systems` and `areas`.
- **Two sharing systems.** Legacy owner-scoped `share_tokens` and per-dashboard
  `dashboard_share_tokens` + grants coexist.
- **Free-text spec columns.** `systems.ratings/solar_size/battery_size` are regex-scraped text.
- **A SQL projection of a code registry.** The `roles` table mirrors `lib/roles/registry.ts` via a
  seed script — two sources of truth.
- **Hidden mode switches.** One `area_bindings` row silently switches an area from
  "union of members' points" to "bindings select everything".
- **Bolted-on nouns.** `device_trackers`/`device_run_periods` and the HWS model solved the same
  problem ("derive a new signal from existing points") with two unrelated mechanisms.

Goals for the redesign: **fast, small, idiomatic; easy for editing tools (the forthcoming web
editor, and agents/scripts) to manipulate via APIs; inspired by Home Assistant's best ideas
(registries, areas, derived helpers, storage-mode dashboards) without its limitations
(single-home, no multi-tenancy, nesting-hostile editor).**

## 2. Locked decisions (agreed with Simon, 2026-07-21)

1. **One ID space; the integer handle is retired.** One-time cutover migration is acceptable.
2. **Hot time-series tables must not bloat.** No UUIDs in `point_readings`/aggregates — compact
   internal integer keys behind a single translation seam (§5).
3. **Eager areas.** Every device gets/joins an area at onboarding; **tz + location live only on
   the area** (HA-style). This reverses the "delete implied areas" leg of the in-flight
   areas-cleanup work — reconcile there before executing either.
4. **Legacy owner-scoped share tokens collapse**: each live token is re-pointed at a dashboard
   (auto-created if needed). One token semantics survives.
5. **Full rename `systems` → `devices`** — table, types, routes, vocabulary. Old handle-era code
   should fail loudly, not compile quietly.
6. **Public IDs are prefixed TypeIDs** (`dev_…`, `pt_…`, `area_…`, `dash_…`; UUIDv7 under base32),
   plus owner-scoped human **slugs** for pretty URLs. Not an HA convention (HA uses raw ULIDs +
   slugs); Stripe-style, chosen because typed IDs turn handle-style confusion into a parse error.
7. **No device grants.** `user_systems` dies with no replacement. Device access = owner
   (nullable `owner_user_id`; NULL = platform-public, e.g. the OpenElectricity region devices)
   + platform admin. **All sharing is dashboard sharing.**
8. **Trackers generalize to `derivations`** — config that turns source points into derived output:
   samples (a derived point — the HWS-model precedent) or intervals (run periods).
9. **Fixed-offset day-bucketing is canonical and endorsed** (§7). IANA zone is display-only.
10. **The descriptor becomes a recursive node tree**; card and tile unify into one primitive (§8).

## 3. The three layers, restated

Unchanged in spirit from areas-and-dashboards.md — the redesign cleans the layers, it doesn't
re-litigate them:

| Layer | Nouns | Owns |
|---|---|---|
| **Physical** | `devices`, `points`, `device_state` | what exists and what it measures |
| **Semantic** | `areas`, `area_members`, `area_bindings`, `derivations` | what things mean (roles) and where they are |
| **Presentation** | `dashboards`, `dashboard_grants`, `share_tokens` | what people see and share |

Capabilities remain **derived at runtime, never stored**. The roles registry remains **code**
(`lib/roles/registry.ts`); its SQL projection dies, replaced by `CHECK` constraints regenerated on
the rare occasion a role is added.

## 4. Entity model & schema

DDL-style sketches (Drizzle is the real source of truth once implemented). All timestamps
`timestamptz` — the epoch-ms `bigint` columns die everywhere. `text` + `CHECK` for enums.

### 4.1 devices (was `systems`)

```
devices
  id               uuid PK            -- v7; public form dev_…
  rid              int  NOT NULL UNIQUE   -- internal recorder key; = legacy systems.id for
                                          -- migrated rows (sessions/outbox migrate by rename)
  owner_user_id    text               -- NULL = platform-public (OE regions); no grants table
  vendor           text NOT NULL      -- was vendor_type
  vendor_site_id   text NOT NULL
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','removed'))
  name             text NOT NULL
  slug             text               -- UNIQUE (owner_user_id, slug)
  model            text
  serial           text
  primary_area_id  uuid NOT NULL REFERENCES areas(id)   -- eager area; tz/location resolve here
  config           jsonb              -- typed DeviceConfig: user-editable knobs. Absorbs the
                                      -- free-text ratings/solar_size/battery_size as structured
                                      -- fields (nameplateKw etc.), capability on/off overrides,
                                      -- updateCadenceSeconds
  adapter_state    jsonb              -- adapter-owned diagnostics/descriptors (was metadata);
                                      -- credentials stay in Clerk, unchanged
  commissioned_on  date
  created_at / updated_at
```

Dies from `systems`: `ratings`, `solar_size`, `battery_size` (→ typed config), `location`,
`timezone_offset_min`, `display_timezone` (→ area), `alias`→`slug`, `display_name`→`name`.

**Deliberately not adopted:** HA's config-entry/device split. LiveOne's point namespace,
credential scope, and polling unit are all 1:1 with the vendor connection; a second table buys
nothing until one connection yields multiple independently-addressable devices.

### 4.2 points (was `point_info`)

```
points
  id               uuid PK            -- THE identity: uuidv5(vendor, vendor_site_id,
                                      -- physical_path); v7 fallback on collision. Re-onboarding
                                      -- a device reproduces the same point ids. Public form pt_…
  rid              int NOT NULL UNIQUE    -- internal recorder key (new global sequence, §5)
  device_id        uuid NOT NULL REFERENCES devices(id)
  physical_path    text NOT NULL      -- was physical_path_tail
  logical_path     text               -- was logical_path_stem
  metric_type      text NOT NULL
  unit             text NOT NULL
  name             text NOT NULL
  default_name     text NOT NULL
  subsystem        text
  transform        text
  active           boolean NOT NULL DEFAULT true
  created_at / updated_at
  UNIQUE (device_id, physical_path)
  UNIQUE (device_id, logical_path, metric_type)
```

The per-device sequential `index` (the `(system_id, point_id)` address) **dies**, and with it the
per-device index allocator and its concurrency care. The `point_uid` identity/address split plan
is absorbed: the registry row *is* the address; the deterministic uuid *is* the identity; one
column.

### 4.3 areas, members, bindings

```
areas
  id               uuid PK            -- PRESERVED verbatim from today: flow_attr_1d and
                                      -- battery_provenance_daily need zero changes
  owner_user_id    text NOT NULL
  name             text NOT NULL
  slug             text               -- UNIQUE (owner_user_id, slug)
  day_offset_min   int NOT NULL       -- canonical fixed-offset day-bucketing (§7); immutable
                                      -- except via an explicit re-bucket operation
  display_timezone text NOT NULL      -- IANA; formatting only, freely editable
  location         jsonb              -- typed AreaLocation (unchanged shape); derives NEM region
  config           jsonb              -- typed AreaConfig: site-level knobs relocated from
                                      -- DeviceConfig — exportTariff, generatorSource,
                                      -- provenance knobs. Site facts, not device facts.
  status           text NOT NULL DEFAULT 'active'
  created_at / updated_at

area_members (was area_devices)
  area_id   uuid NOT NULL REFERENCES areas(id)   ON DELETE CASCADE
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE
  ordinal   int NOT NULL DEFAULT 0
  PK (area_id, device_id)

area_bindings
  id          uuid PK
  area_id     uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE
  role        text NOT NULL CHECK (role IN ('solar','battery','load','grid','ev','generator'))
  metric_type text NOT NULL
  point_id    uuid NOT NULL REFERENCES points(id)
  priority    int NOT NULL DEFAULT 0  -- slot-selection order when several points satisfy one
                                      -- (role, metric): lowest wins. NOT the old `ordinal` —
                                      -- that column's KV-ref-stability job dies with the handle;
                                      -- priority survives because deterministic per-slot
                                      -- selection needs it when two member devices each offer
                                      -- a point matching the same slot (e.g. one battery
                                      -- observed by both a meter and an inverter)
  transform   text                    -- per-binding override; NULL = inherit point.transform
  created_at
  UNIQUE (area_id, role, metric_type, point_id)
  INDEX (point_id)                    -- the KV fan-out reverse lookup
```

**Binding semantics become explicit and per-role** (removing today's all-or-nothing cliff):

1. An area's *visible point set* is **always** the union of its members' points.
2. An area's *role resolution* is per-role: if bindings exist for role R, they define R;
   otherwise R derives from members' points by stem match (`stemMatchesRole`).

This subsumes both current behaviours (fully-curated Kinkora; binding-less area-of-one) without
the mode switch where adding one binding silently deselects every other role.

**Shape validation is real, not cosmetic** (absorbed from info-producers): the bindings `PUT`
rejects a binding whose point `(logical_path, metric_type)` is incompatible with the role's
expected shape — promoting today's advisory UI dot to enforcement.

**Per-slot resolution is deterministic** (absorbed from info-producers — today's provenance fold
picks sources by DB return order, first-wins or last-wins depending on the slot). One resolver,
used by every consumer (fold, cards, derivations), seeks each `(role, metric)` slot in order:

```
explicit binding (lowest priority wins) → auto shape-match (exactly ONE candidate)
  → area config producer (areas.config: generatorSource, exportTariff, …) → absent
```

Each slot resolves to `{point | config-value | absent, mode, available}`. Two candidates with no
explicit binding is a "needs your choice" state surfaced in the editor, never a silent pick.
`available:false`/stale feeds the existing estimated-confidence channel — a missing source
degrades to best-effort, never a wrong fact. Site-level config values are just config-kind
producers in the same chain, which also fixes the old scoping wrinkle (config lived on a device;
consumers are area-scoped — in v4 those knobs live on `areas.config`, §4.3).

### 4.4 derivations (generalizes `device_trackers`) + derived_intervals

The general concept: **a derivation is config that computes a new signal from existing points.**
Two output shapes:

- **samples** → a derived point in the normal pipeline (the shipped HWS model is exactly this);
- **intervals** → an event/run store (today's generator run-tracking).

```
derivations
  id            uuid PK
  area_id       uuid NOT NULL REFERENCES areas(id)
  kind          text NOT NULL         -- 'run-detector' | 'hws-model' | future kinds
  role          text                  -- CHECK as bindings; e.g. 'generator' for run-detector
  name          text NOT NULL
  enabled       boolean NOT NULL DEFAULT true
  output        text NOT NULL CHECK (output IN ('point','intervals'))
  output_point_id uuid REFERENCES points(id)   -- when output='point'
  params        jsonb NOT NULL        -- typed per kind: thresholds/hysteresis/delays for
                                      -- run-detector; model constants for hws-model
  source_points jsonb NOT NULL        -- typed point refs (signal, energy, …) by uuid
  detector_version int NOT NULL DEFAULT 1
  created_at / updated_at
  UNIQUE (area_id, role) WHERE role IS NOT NULL

derived_intervals (data layer, was device_run_periods)
  derivation_id uuid NOT NULL REFERENCES derivations(id)
  start_time    timestamptz NOT NULL
  end_time      timestamptz           -- NULL = open
  …stats columns unchanged (duration, energy_kwh, max/min/avg power, sample_count)…
  PK (derivation_id, start_time)
  UNIQUE (derivation_id) WHERE end_time IS NULL   -- one open run, kept
```

This kills the `(logical-system-int, role)` pun in run-periods keys and gives pump runs, EV charge
sessions, and outage detection a home without new tables. It is the structural cousin of the
info-producers plan: producers/consumers negotiate *which* points feed a derivation; the
derivation row is the persisted wiring.

### 4.5 device_state (was `polling_status`) — state, not config

1:1 satellite of `devices` (PK `device_id`), columns unchanged. It is **operational state**,
written every poll: never exported, never granted, no public ID, outside the config model.

### 4.6 dashboards, grants, revisions

```
dashboards
  id           uuid PK               -- public form dash_…
  legacy_id    int UNIQUE            -- frozen: today's serial id, for /dashboard/id/{n} 301s
  owner_user_id text NOT NULL
  name         text NOT NULL
  slug         text                  -- UNIQUE (owner_user_id, slug); pretty URLs unchanged
  doc          jsonb NOT NULL        -- the v4 node tree (§8); stays ONE opaque document
  revision     int NOT NULL DEFAULT 1
  created_at / updated_at

dashboard_revisions                  -- cross-session undo; docs are KBs, keep last ~20
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE
  revision     int NOT NULL
  doc          jsonb NOT NULL
  saved_by     text NOT NULL
  saved_at     timestamptz NOT NULL
  PK (dashboard_id, revision)

dashboard_grants
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE
  user_id      text NOT NULL
  role         text NOT NULL CHECK (role IN ('admin','viewer'))
  created_at
  PK (dashboard_id, user_id)

users
  clerk_user_id        text PK
  default_dashboard_id uuid REFERENCES dashboards(id) ON DELETE SET NULL
  created_at / updated_at
```

The descriptor stays **one JSONB document** — re-affirming the recorded decision (nothing queries
cards in SQL; atomic saves; trivially copyable/exportable; normalization would create two sources
of truth). What normalization would have bought — granular edits — is delivered cheaper by
revisions + whole-doc PUT (§9).

### 4.7 share_tokens (unified)

```
share_tokens
  token        text PK               -- 3-word phrase; existing tokens survive VERBATIM
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE
  label        text
  created_at   timestamptz NOT NULL
  expires_at / revoked_at / last_used_at timestamptz
```

One semantics: **a token = read access to one dashboard's live-derived scope.** Scope is
recomputed from the doc on every read (never snapshotted), by the type-agnostic envelope walk
(§8.3). Legacy owner-scoped tokens: the cutover re-points each *live* token at a dashboard
(auto-created from the owner's area default group if none exists); dead/expired tokens drop.
Token strings embed no IDs, so no shared URL breaks.

### 4.8 What dies (complete)

**Tables:** `systems` · `point_info` · `user_systems` (no replacement) · `roles` ·
`share_tokens` (legacy) + `dashboard_share_tokens` (→ unified) · `area_devices` (→
`area_members`) · `device_trackers`/`device_run_periods` (→ `derivations`/`derived_intervals`) ·
`polling_status` (→ `device_state`).

**Columns/concepts:** `areas.legacy_system_id` (**the handle — the headline deletion**) ·
`point_info.index` + the per-device allocator · `point_info.point_uid` (becomes `points.id`) ·
`systems` free-text spec columns · tz/location on devices · `area_bindings.ordinal` + int point
pair · dashboards' serial addressing (demoted to frozen `legacy_id`) · all epoch-ms bigints ·
the `SystemsManager` virtual-system synthesis (`synthesizeAreaView`/`isAreaHandle`) · the
≥1,000,000 synthetic handle allocator · KV `latest:system:N` / `subscriptions:system:N`
keyspaces and the `"systemId.pointIndex"` ref grammar · `deviceSystemId` in descriptors ·
`?systemId=` as primary address (kept only as a compat alias).

## 5. ID strategy — one seam

**Public:** every config row has a UUIDv7 `id`; the wire/URL form is a TypeID
(`dev_01j9xz…`, 26 chars). One codec module (`lib/ids/`); the DB never stores prefixes.

**Internal (hot):** a single global integer per registry row, HA-recorder-`metadata_id` style:

- `points.rid` — new global sequence. `point_readings` / `agg_5m` / `agg_1d` re-key to
  `(point_rid, time)`: **smaller than today's** `(system_id int, point_id int, time)` (4 bytes
  saved per index entry), answering the "wouldn't UUIDs waste space" concern by going the other
  direction.
- `devices.rid` — **preserves today's `systems.id` values**, so `sessions` (~870K rows) and
  `observations_outbox` migrate by column rename, no rewrite, and old logs stay greppable.
- Areas need no rid: every area-keyed serving table (`flow_attr_1d`, `battery_provenance_daily`)
  is already uuid-keyed and survives untouched.

**The seam rule:** one data-access layer (registry cache + time-series DAO) owns uuid↔rid.
Above it — API routes, capabilities, dashboards, KV, sankey, provenance — speaks uuids only.
Below it — readings, aggregates, sessions, outbox, the receiver's insert path — speaks rids only.
Nothing else may import the rid columns (lint-enforced on the schema exports).

## 6. Access model

- **Devices:** owner or platform admin; `owner_user_id IS NULL` = platform-public (readable by
  all, e.g. OE region devices). No grants table.
- **Areas:** owner or platform admin. Members must be owner's (or public) devices.
- **Dashboards:** the **only sharing unit** — owner, `dashboard_grants` (admin/viewer), or a
  share token. Grant/token scope is derived live from the doc's envelope refs.

## 7. Time: fixed-offset days, endorsed

Day-bucketing keeps the deliberate fixed-offset scheme — **every day of the year is exactly
24 hours.** The DST-aware alternative was considered and rejected:

- DST-aware days are 23/25h twice a year; 5m→1d rollups need transition-aware bucketing;
  re-aggregation stops being idempotent; every "daily" comparison carries an asterisk.
- The domain agrees: **AEMO settles the NEM in fixed AEST (+10) year-round** — market time has no
  DST. Grid-aligned energy accounting argues *for* the fixed offset.
- What DST-awareness buys (wall-clock alignment of the day boundary at 2am twice a year) is worth
  nearly nothing for energy data.

So: `areas.day_offset_min` is the canonical bucketing key; `areas.display_timezone` (IANA) is for
formatting only. The wart being fixed is *duplication* (tz on both device and area), not the
scheme. **Change policy:** `day_offset_min` is immutable after creation except via an explicit
re-bucket operation that regenerates `agg_1d` / `flow_attr_1d` / provenance-daily for that area
(the recompute machinery already exists); `display_timezone` is freely editable.

## 8. The v4 dashboard document — a recursive node tree

### 8.1 Model

Card and tile **unify into one primitive**. The document is a tree of two node kinds:

```jsonc
{
  "version": 4,
  "root": {
    "id": "n_a1b2", "kind": "group",
    "children": [
      {
        "id": "n_c3d4", "kind": "group",
        "area": "area_01j9xz…",          // context binding — inherited by descendants
        "heading": true,                  // renders the area header (this IS a v3 "section")
        "children": [
          {
            "id": "n_e5f6", "kind": "group", "direction": "row", "wrap": true,
            "children": [                 // this row group IS a v3 "tiles" card
              { "id": "n_g7h8", "kind": "card", "type": "solar",  "size": { "columns": 2 } },
              { "id": "n_i9j0", "kind": "card", "type": "battery","size": { "columns": 2 } },
              { "id": "n_k1l2", "kind": "card", "type": "oe-grid",
                "device": "dev_01j9ab…", "size": { "columns": 2 } }
            ]
          },
          { "id": "n_m3n4", "kind": "card", "type": "chart",
            "config": { "variant": "stacked-areas", "split": "load" } },
          { "id": "n_o5p6", "kind": "card", "type": "sankey" },
          { "id": "n_q7r8", "kind": "card", "type": "generator-runs",
            "device": "dev_01j9cd…" }
        ]
      }
    ]
  }
}
```

- **`group`**: `{id, kind:'group', area?, device?, direction?:'row'|'column', wrap?, heading?,
  hidden?, size?, children: Node[]}` — a first-class flex layout node.
- **`card`**: `{id, kind:'card', type, area?, device?, hidden?, size?, config?}` — the leaf.
  A "tile" is simply a small card (`size.columns` low); the tile/card registries merge.
- **Context inheritance:** `area`/`device` on any node is inherited downward; a card consumes the
  nearest binding (generalizing v3's `deviceSystemId ?? section-handle`). "Sections" stop being
  special — a group bound to an area *is* a section, and renders the area header by default.
  Mixed-area composition falls out for free at any depth.
- **Layout** = child order + optional `size: {columns: 1–12}` on a 12-column grid + group flex
  semantics. **No (x,y) coordinates** — absolute coords rot across breakpoints; order+size is
  where HA's sections view landed after years of grid-layout pain, and it makes agent edits
  trivial ("move the chart above the sankey" = one splice).
- **Depth cap (~4) in validation.** HA's lesson: arbitrary nesting (vertical-stack/
  horizontal-stack *cards*) is what broke their visual editor. Our groups are first-class layout
  nodes with simple semantics, not cards-as-containers — but the editor should still encourage
  shallow trees; the format being recursive doesn't oblige the UX to expose infinite depth.

### 8.2 Stored vs derived (rule kept verbatim from v3)

Store **choices + structure** only. Derived at render, never stored: area/device display names,
headers, default layout, capability sets, availability, timezone. This is what keeps docs small
and rename-proof.

### 8.3 The security invariant

**Scope-bearing references live ONLY in envelope fields (`node.area`, `node.device`) — never
inside `config`.** Share-scope derivation and the authoring no-escalation check are one
type-agnostic tree walk over fixed positions. A future or unknown card type can never smuggle a
reference the scope resolver doesn't see (refs in `config` simply don't grant access; worst case
the card 403s on fetch).

### 8.4 Validation posture

- **Envelope: strict** (zod; malformed ⇒ 422, never persisted). `id` required on every node —
  server-assigned when absent (generalizes `normalizeDescriptor`; still idempotent).
- **`type`: open string, warn-not-reject.** Unknown card types persist with their opaque `config`
  intact (renderer shows a labeled placeholder) — HA's custom-card pass-through precedent; a
  newer client or agent must not have its config destroyed by an older validator.
- **Known types: strict per-type `config` schemas.**
- **References: always strict** — every `area`/`device` must exist and be readable by the owner,
  regardless of card type.

## 9. Edit semantics & API surface

### 9.1 Primary edit mechanism: whole-doc PUT + optimistic concurrency

```
GET  /api/v4/dashboards/dash_…            → 200, ETag:"17", { id, name, slug, revision, doc }
PUT  /api/v4/dashboards/dash_…  If-Match:"17"  { doc }
     → 200 { revision: 18, doc: …normalized… }    // canonical doc echoed back
     → 412 { error:"revision-conflict", current:19 }
     → 422 { errors:[{path,code,message}], warnings:[…] }
POST /api/v4/dashboards/dash_…/validate   → { valid, errors, warnings, normalized }   // dry-run
```

Why whole-doc PUT: docs are KBs; the editor holds the whole doc anyway (undo = a client-side doc
stack; save = PUT); agents want `GET → edit → PUT` read-modify-write; `If-Match` makes concurrent
clobbering impossible rather than unlikely. JSON Patch rejected (index paths are brittle exactly
under reorder — the most common edit); granular card REST rejected (multiplies routes and
validation entry points for zero benefit). `If-Match` is optional (absent = last-write-wins) so
casual scripts stay one-liners. Every write echoes the normalized canonical doc, so client state
never drifts from storage. `dashboard_revisions` covers cross-session undo
(`GET …/revisions`, `POST …/revisions/{n}/restore` — restore copies forward, never rewinds).

### 9.2 Resource tree

All under `/api/v4/`. Conventions: plural nouns; TypeIDs in paths; `PATCH` = partial meta;
**`PUT` = declarative full-replace for collections** (server diffs, applies transactionally,
refreshes derived state, returns the new state — one mental model for every list); all KV/cache
invalidation happens **inside** handlers (tools never know KV exists).

| Route | Methods | Notes |
|---|---|---|
| `/devices` | GET | readable devices: id, name, vendor, status, capabilities |
| `/devices/{id}` | GET, PATCH | PATCH: name/config meta |
| `/devices/{id}/points` | GET | points with `pt_` ids + role suggestions |
| `/areas` | GET, POST | POST `{name, slug?, members:[dev_…], location?, day_offset_min, display_timezone}` |
| `/areas/{id}` | GET, PATCH, DELETE | GET = meta + members + bindings + capabilities in ONE payload |
| `/areas/{id}/members` | PUT | full replace (replaces POST/DELETE pair) |
| `/areas/{id}/bindings` | PUT, GET | full replace, kept from today (already the most tool-friendly shape); re-keyed to `pt_` ids |
| `/areas/{id}/eligibility` | GET | unified card catalog + capabilities for the add-card gallery; **grey-out only, never render authority** |
| `/areas/{id}/resolution` | GET | read-only per-slot resolution report: which producer fills each (role, metric), by which mode (`explicit\|auto\|config\|absent`), availability — the "what auto-connected" discoverability view (§4.3) |
| `/areas/{id}/default-group` | GET | capability-derived starter group (was default-section) |
| `/areas/{id}/derivations` | GET, PUT | the derivations list, full-replace |
| `/dashboards` | GET, POST | POST `{name, slug?, seedArea?}` |
| `/dashboards/{id}` | GET, PUT, PATCH, DELETE | §9.1; PATCH = `{name?, slug?}`; GET supports `?include=resolved` |
| `/dashboards/{id}/validate` | POST | dry-run |
| `/dashboards/{id}/revisions` | GET (+ restore) | cross-session undo |
| `/dashboards/{id}/shares` | GET, POST, PATCH, DELETE | unified tokens; PATCH relabel, DELETE revoke |
| `/dashboards/{id}/grants` | GET, PUT | full replace |
| `/export` | GET | §9.3 |
| `/import` | POST | `?dry_run=1` default-on |

### 9.3 Whole-home export/import

`GET /export` → one JSON snapshot (areas + members + bindings + derivations + dashboards docs;
excludes secrets, tokens, grants, credentials). `POST /import?dry_run=1` returns a
create/update/skip diff keyed by ID; `dry_run=0` applies. Simultaneously: backup, "agent,
restructure my whole config" (edit one file, import), and the seed of the planned HA export.

### 9.4 What the web editor needs (checklist)

GET with revision/ETag · PUT echoing normalized doc · 412 conflict signal · validate dry-run
(live lint) · `/areas` + `/eligibility` (add-card gallery with grey-out) · `/default-group`
(one-click seeding) · `?include=resolved` (preview with real names, no second fetch) ·
server-assigned stable node ids (drag-drop keys, undo reconciliation) · order+size layout (reorder
= splice, no geometry engine) · revisions + restore · PUT-full-replace wiring tabs · zero
KV/cache awareness.

## 10. Serve path (and the SSR initiative)

**One config fetch, N data fetches:**

1. `GET /api/v4/dashboards/{id}?include=resolved` — the doc plus resolved context: per referenced
   area/device its name, layout hints, capabilities, display timezone. Everything the shell needs
   to paint structure/headers instantly; no points, no readings; **cacheable per
   `(dashboard, revision)`** — the revision is a free cache key.
2. Cards self-fetch live data keyed by public ID: `/api/data?area=area_…` / `?device=dev_…`
   (`?systemId=N` survives as a compat alias via `legacy_handles`), `?access=` appended for
   shared views exactly as today.

**Note for the server-side-rendering workspace** (perf-test-instrumentation): this design is
SSR-friendly by construction and should be treated as the target contract —

- the resolve step (doc + names/capabilities) is a pure server-side function; a server component
  can call it in-process instead of via HTTP (the shared view already does this);
- `(dashboard_id, revision)` is a stable cache key for any server-rendered shell/fragment;
- per-card data fetches are the only dynamic part; they key on TypeIDs post-cutover, integer
  `systemId` until then;
- the descriptor's node tree (not v3 sections/cards/tiles) is the shape to render against —
  coordinate with this proposal before baking v3 shapes into an SSR pipeline.

## 11. Migration (one-time cutover)

**Prep, dark (no user impact):** finish `point_uid` backfill → NOT NULL · ship TypeID codec +
registry cache · v3→v4 doc rewriter with round-trip validation (v3 section → area-bound group with
heading; v3 tiles card → row group of small cards; `deviceSystemId` → `device`) · rehearse the
whole cutover on a prod snapshot branch · pre-create new tables empty.

**Cutover window (ordered):**

1. **Freeze ingest**: pause pollers/crons; drain outbox + QStash to zero (no in-flight int-keyed
   messages).
2. **Mint registries**: `devices` from `systems` (rid = old id); eager area-of-one for any device
   without an area (tz/location copied up verbatim); `points` from `point_info` (id = point_uid,
   rid = new sequence); `areas` carried over with ids preserved, `day_offset_min` = old
   `timezone_offset_min`.
3. **Freeze `legacy_handles`**: `(handle int PK, device_id uuid NULL, area_id uuid NULL)` —
   every old `systems.id` and every `areas.legacy_system_id`. ~Hundreds of rows, permanent.
4. **Rewrite hot tables**: JOIN-insert `point_readings` (~13M), agg_5m (~3M), agg_1d into
   `(point_rid, time)`-keyed twins; rename-swap; keep `_old` until validated. Sessions/outbox:
   column rename only.
5. **Transform config**: bindings → `pt_` uuids · trackers → `derivations` + `derived_intervals`
   re-key · grants · unified `share_tokens` (dashboard tokens 1:1; live legacy owner tokens
   re-pointed at auto-created dashboards) · dashboards get uuids + frozen `legacy_id`, docs
   rewritten v3→v4 · `users.default_dashboard_id` re-pointed.
6. **KV**: delete `latest:system:*` / `subscriptions:system:*`; rebuild the subscription registry
   under the new keyspace (`latest:area:{area_…}` / `latest:device:{dev_…}`); warm from PG or
   accept one poll cycle cold.
7. **Deploy the cutover build**; parity-check (row counts; per-point last value; per-area
   point-set vs a pre-freeze snapshot; agg_1d day boundaries; flow_attr_1d sums untouched);
   unpause pollers.

**Permanent thin shims:** `?systemId=N` resolved via `legacy_handles` (area first, else device) ·
`/dashboard/id/{int}` 301 via `dashboards.legacy_id` · `/dashboard/{user}/{slug}` and `/device/*`
slug URLs unchanged · share-token strings unchanged.

## 12. Deliberate deviations from full clean-sheet (argued)

1. **sessions/outbox keep an int `device_rid`.** Rewriting ~870K rows buys 12 bytes/row of
   cosmetics on tables no API addresses. The rid *is* the sanctioned internal key — the boundary
   working as designed.
2. **The doc stays one JSONB blob.** Cards are layout-coupled presentation; nothing queries them
   in SQL; normalization = two sources of truth. Granular editing is solved by revisions + PUT.
3. **Two device jsonb bags** (`config` user-editable vs `adapter_state` adapter-owned). The
   ownership boundary is the point; merging recreates the old `metadata` grab-bag.
4. **`devices.rid` preserves old ids** rather than a dense resequence — makes sessions/outbox a
   rename and keeps old logs greppable; density has no value.
5. **No device or area ACLs.** The dashboard is the only sharing unit; owner + platform-public
   covers devices. A third grant surface is speculative.
6. **Fixed-offset day-bucketing kept** over DST-aware wall-clock days (§7).
7. **Labels deferred** — an orthogonal tag dimension is a clean future add
   (see identity-address-split-and-labels.md); nothing reads them yet.

## 13. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Hot-table rewrite exceeds the window (13M+3M rows) | M | rehearse on snapshot; pre-copy + delta-catchup if needed; ingest freeze makes it deterministic |
| v3→v4 doc rewrite bug breaks a live dashboard | M | round-trip validator; renderer accepts both shapes for one release; old descriptor retained until validated |
| Wrong `primary_area_id` mis-buckets daily aggregation | M | migration copies tz verbatim into minted areas; agg_1d boundary parity check |
| Recursive docs let users build unmaintainable trees | M | depth cap in validation; editor encourages shallow; HA's nesting lesson documented |
| KV cold start after re-key | L | warm from PG or accept ≤1 poll cycle |
| Binding-order changes alter sankey/series enumeration | L | assert per-area series-set equality pre/post |
| In-flight int-keyed queue messages | L | drain-to-zero in step 1; payload schema v2 carries device uuid |
| uuidv5 point-id collision on duplicate sites | L | v7 fallback, as today, now documented on `points.id` |

## 14. Interactions with in-flight work

- **areas-cleanup (A2 pending)**: its "delete implied areas / stop minting areas-of-one" leg is
  **reversed** by locked decision 3 (eager areas). Reconcile before executing either — the
  deletion script should not run if this proposal proceeds.
- **flow-matrix unification (`simonhac/bullard`, `FLOW_ATTR_UNIFIED`)**: complementary —
  flow_attr_1d is area-uuid-keyed and survives the cutover untouched; land it first.
- **SSR / perf workspace (perf-test-instrumentation)**: see §10 — educate it with this doc so it
  renders against the v4 node tree and the `(dashboard, revision)` cache key, not v3 shapes.
- **info-producers plan**: **superseded by this doc** (per-slot resolver, priority, shape
  validation, config producers, availability all absorbed into §4.3; `derivations` §4.4 is the
  persisted-wiring noun). Its P2 should be implemented against the v4 model, not the old seams —
  though its determinism fixes could land earlier as a standalone bug fix if provenance
  correctness demands it.

## 15. Open questions

1. Group `direction`/`wrap` defaults and the exact flex semantics — settle when the web editor's
   layout engine is prototyped.
2. Does `oe-grid` stay a per-device card, or become an area-level card that resolves its device
   via the area's location (as grid-signals capability already does)? Lean: area-level.
3. Depth cap value (4?) and whether the editor exposes group creation at all in v1.
4. Whether `/api/v4/` routes coexist with old routes during a burn-in, or the cutover build
   replaces them atomically (lean: replace — one-time cutover is the agreed posture; only the
   thin shims survive).
