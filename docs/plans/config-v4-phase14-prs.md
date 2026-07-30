# Config v4 Phase 14 — the 22 PRs, in orchestrator detail

> **Status: IN FLIGHT (written 2026-07-31, at `fa64b2d2`).** Companion to
> [config-v4-execution-plan.md](config-v4-execution-plan.md) §Phase 14, which states the goal in one
> page. This file is the _implementation_ detail: one section per PR, each self-contained enough that
> an agent with no prior context can execute it.
>
> **Read before starting anything:** the **Traps and rules** section of the execution plan. It is not
> background reading — several entries there are the direct cause of a prod outage, and at least four
> of them apply to every PR below.
>
> Phase 14's first PR (strict area-ref decode, [#305](https://github.com/simonhac/LiveOne/pull/305))
> shipped before this file existed. It is **not** re-numbered here: the numbering below is the
> orchestration pipeline's, starting at PR 1 = this document.

## 🛑 Migration numbers are RESERVED, and assigned by the orchestrator only

**0053** DROP `dashboards.descriptor` (PR 16) · **0054** rewrite `devices.vendor_site_id` for helper
devices → `helper:area:ar_…` (PR 17) · **0055** `derived_intervals.{max,min,avg}_power_w` →
signal-neutral names carrying a unit (PR 21).

**No agent may run `db:pg:generate` and claim a number.** Parallel worktrees collide: two workspaces
each generate `0053_*` for different DDL, and the only damage is in the drizzle journal — which is
exactly the file you cannot fix by force. If your PR needs DDL that is not one of the three above,
**stop and ask the orchestrator for a number.**

## How to use this document

Each PR section has the same six parts, and they are load-bearing:

| Part           | What it is for                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| **Goal**       | One sentence. If the PR does more than this, it has scope-crept — split it.                                   |
| **Inventory**  | The measured file:line list. Re-measure before starting (see below) — do not trust these numbers blind.       |
| **Steps**      | Ordered, concrete edits.                                                                                      |
| **Proof**      | What must be true before opening the PR. Each PR has a _different_ proof — that is why they are separate PRs. |
| **Do NOT**     | The specific ways this PR goes wrong.                                                                         |
| **Depends on** | What must have LANDED first, and what may run beside it.                                                      |

## 🛑 Standing rules for every PR in this phase

1. **Re-measure the inventory first.** Every count and line number in this document was measured at
   `fa64b2d2` on 2026-07-31. `git fetch origin main && git log --oneline -1` and re-run the greps
   before you plan your edits. A doc comment naming code is a _claim about code_ — verify it.
2. **Never push to `main`.** Branch off `main`, `gh pr create --base main`. No exceptions.
3. **`tsc` is blind to raw SQL, to string-built keys, and to a projection-less `.select()`.** Every PR
   here must **hand-run a raw-string grep** for what it changed, and must **drive** the changed path,
   not merely compile it.
4. **Exercise WRITERS, not just readers.** A prod device-create bug hid for three days behind an
   `ON CONFLICT … coalesce` because only read paths were driven.
5. 🛑 **`liveone-dev` (DB + KV) is SHARED** by every worktree, Vercel preview and Simon's local dev.
   One mutating HTTP driver at a time; create and delete your own scratch entities.
6. ⚠️ **`git stash` is repo-wide, not per-worktree** — parallel agents share one stack and
   `lint-staged` shells out to it. Commit instead; `--no-verify` + prettier by hand if a hook fights.
7. ⚠️ **Never `npm run build`** (it kills the dev server) — `npm run build:local && npm run type-check`.
   A stale `.next-build/types/validator.ts` fails `type-check` with `TS2307` after a rebase across a
   route rename → `rm -rf .next-build`.

## The standing verification bar

Green baseline measured on `fa64b2d2`, 2026-07-31 — **this is what "unchanged" means**:

```
npm test               →  138 suites; 1371 passed, 5 skipped (1376 total)
npm run type-check     →  exit 0
npm run check:readings →  readings boundary green
npm run check:routes   →  exit 0
npm run build:local    →  succeeds   (NOT `npm run build`)
```

> ⚠️ The Phase 13 brief's bar (1347/1352) is **stale** — the suite grew. Every PR must restore all
> five; a PR that changes the test count must say **why** in its body.

## 🛑 Two ways to write a test that is silently never run

Measured in `jest.config.js`, `jest.config.all.js`, `jest.config.integration.js` — all three agree:

- `testMatch` is `**/__tests__/**/*.test.ts`. **A `.tsx` test file is not collected.** Jest exits 0.
- `roots` are `<rootDir>/lib`, `/app`, `/scripts`, `/packages`. **`components/` is NOT a root** — and
  there is no `components/__tests__` directory today, so nothing has ever caught this. A test for a
  component must live under `lib/**/__tests__/` (or one of the other three roots).

Both traps apply to PR 5, which is a React test for components. Put it at
`lib/dashboard/__tests__/…​.test.ts` and import the components across the boundary.

`testEnvironment` is `"node"` in all three configs; there is **no jsdom and no @testing-library**.
`react-dom@19.1.1` is present, so `renderToStaticMarkup` works with zero new dependencies.

## The pipeline

```
Wave 0   1  docs (this file)
Wave 1   2  STEP 0: exercise the dark /api/v4 surface   ‖ 3 pre-landable extractions ‖ 4 TileView/TileId move
Wave 2   5  prop-equivalence harness  →  6 CardRenderProps v4-native  →  7 one registry
Wave 3   8  buildAreaStrategy emits v4  →  9 port /device/{id}; delete Dashboard.tsx + tiles-card
Wave 4  10 area mutations ‖ 11 sharing ‖ 12 orphan reads   →  13 clients onto v4; DELETE legacy trees
Wave 5  14 AddAreaDialog onto the doc  →  15 stop reading/writing descriptor  →  16 migration 0053 DROP
Wave 6  17 vendorSiteId leak + 0054 ‖ 18 delete the /api/system* shims ‖ 19 daily-stripe ‖ 20 heatmap
        21 signal-neutral rename + 0055
Wave 7  22 closeout
```

**Critical path:** 2 → 5 → 6 → 7 → 8 → 9 → 13 → 14 → 15 → 16 → 22. PRs 3, 4, 17, 18, 19, 20, 21 are
off it and can land whenever their (light) dependencies allow.

## 🛑 The correction that reshapes the phase: there are TWO live v3 render paths

The execution plan describes exactly one (`DashboardClient` → `components/Dashboard.tsx`) and never
mentions the second. Measured:

- **`/dashboard/{…}`** — `components/DashboardClient.tsx:231` branches `dashboard.doc ? <DashboardV4View> : <Dashboard>`.
  Since the Phase 8/10 cutover `dashboards.doc` is NOT NULL, **the v3 branch is never taken.**
- **`/device/{id}`** — `app/device/[...slug]/page.tsx:262` server-builds a transient `DashboardV3`
  from `buildAreaStrategyForHandle` and passes it to `components/DeviceViewer.tsx:169`, which renders
  it through `components/Dashboard.tsx:9`. **This one is live on every page view.**

`components/Dashboard.tsx` has exactly two importers — `components/DeviceViewer.tsx:9` (live) and
`components/DashboardClient.tsx:8` (the never-taken fallback). **`lib/dashboard/v3.ts` and the v3
renderer cannot die until `/device/{id}` is ported.** That is PR 9, and it is why PR 9 sits on the
critical path between the registry work and the client migration.

## Counts, re-measured — what the execution plan gets wrong

| Plan says                                         | Measured at `fa64b2d2`                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 28 legacy handlers / 15 routes, 16 mut + 12 reads | **28 / 15 is right; the split is 15 mutations + 13 reads.**                                                                             |
| 12 unbuilt v4 mutation endpoints                  | 12 legacy mutation _handlers_ have no twin, but the §9.2 target collapses two pairs → **10 v4 handlers to build** (below).              |
| 7 legacy reads with no v4 twin                    | 7 is right, but **3 of the plan's list are dead** and 2 belong to the sharing PR → **4 orphan area reads** (PR 12).                     |
| "~362 LOC of bridge tests"                        | The two strictly-bridge files are **285 LOC** (`v3-to-v4.test.ts` 180 + `v4-adapt.test.ts` 105).                                        |
| "19 plugins to port"                              | **9/9 tiles are already v4-native**; the port is 9 card plugins (`tiles-card` is deleted, not ported).                                  |
| "7 card plugins read nothing but `handle`"        | **5** read only `handle` (`amber-now`, `amber-timeline`, `battery-contents`, `chart`, `ev-provenance`); `sankey` reads no props at all. |

**Why 12 legacy mutation handlers become 10 v4 handlers.** Clean-sheet §9.2 makes collections
full-replace: `POST`+`DELETE /api/areas/{id}/devices` become **one** `PUT /api/v4/areas/{id}/members`,
and `POST`+`DELETE /api/dashboards/{id}/grants` become **one** `PUT /api/v4/dashboards/{id}/grants`.
Do not build twelve.

---

# PR 1 — This document, and three corrections found by measuring

**Goal:** land the per-PR brief plus the execution-plan edits that record the second live v3 render
path and the corrected counts.

**Docs only.** No code, test, migration or config file changes.

**Proof:** `npx prettier --check "docs/**/*.md"` passes; every file:line reference resolves.

**Depends on:** nothing. Everything else may start beside it.

---

# PR 2 — 🛑 STEP 0: exercise the dark `/api/v4` surface

**Goal:** every one of the 12 `/api/v4` handlers is driven over real HTTP at least once, and route
tests exist, before any legacy handler is retired onto a v4 twin.

**This is the enabler for PRs 10–13 and the highest-value PR of the phase per line of code.**

### Why it is not optional

Measured 2026-07-31: **zero `fetch()` callers** of any `/api/v4/*` route anywhere in `app/`,
`components/`, `lib/`, `hooks/` or `scripts/`, and **no `app/api/v4/__tests__` directory**. The v4
_helper_ libs are unit-tested (`lib/dashboard/__tests__/v4-routes.test.ts`, `v4-seed.test.ts`,
`v4-validate.test.ts`, `v4-adapt.test.ts`) but every one of them mocks its dependencies and never
constructs a request. **This code has never run.** Expect defects.

### Inventory — the 12 handlers, 571 LOC across 8 route files

| Handler                                 | File:line                                         |
| --------------------------------------- | ------------------------------------------------- |
| `GET /api/v4/areas`                     | `app/api/v4/areas/route.ts:12`                    |
| `GET /api/v4/areas/{id}`                | `app/api/v4/areas/[id]/route.ts:15`               |
| `GET /api/v4/areas/{id}/default-group`  | `app/api/v4/areas/[id]/default-group/route.ts:15` |
| `GET /api/v4/areas/{id}/eligibility`    | `app/api/v4/areas/[id]/eligibility/route.ts:24`   |
| `GET /api/v4/areas/{id}/resolution`     | `app/api/v4/areas/[id]/resolution/route.ts:6`     |
| `GET /api/v4/dashboards`                | `app/api/v4/dashboards/route.ts:30`               |
| `POST /api/v4/dashboards`               | `app/api/v4/dashboards/route.ts:37`               |
| `GET /api/v4/dashboards/{id}`           | `app/api/v4/dashboards/[id]/route.ts:27`          |
| `PUT /api/v4/dashboards/{id}`           | `app/api/v4/dashboards/[id]/route.ts:47`          |
| `PATCH /api/v4/dashboards/{id}`         | `app/api/v4/dashboards/[id]/route.ts:93`          |
| `DELETE /api/v4/dashboards/{id}`        | `app/api/v4/dashboards/[id]/route.ts:133`         |
| `POST /api/v4/dashboards/{id}/validate` | `app/api/v4/dashboards/[id]/validate/route.ts:11` |

### Steps

1. Add `scripts/utils/v4-surface-smoke.ts` — mints a Clerk session JWT, drives all 12 handlers against
   a running dev server, prints a per-handler status + shape summary, and **deletes every scratch
   entity it created**. Model the auth on the CLAUDE.md recipe; the JWT expires in ~60 s, so mint it
   inside the run, not before it.
2. Add route tests under `app/api/v4/__tests__/` (`.test.ts`, node env) that construct a `NextRequest`
   and call the exported handler directly — auth mocked, DAO mocked. These are the regression net;
   the smoke script is the "has it ever run" proof.
3. Record every defect found as its own commit in this PR, or as a follow-up issue if it is large.
   **Do not fold a behaviour fix into a later PR** — the point of STEP 0 is that the defects surface
   here, attributable, before anything depends on them.

### Known shape gaps to look for (found while writing this brief, not yet driven)

- **`GET /api/v4/areas` does not emit `legacySystemId`.** It returns `{id, displayName, chartCapable}`
  (`app/api/v4/areas/route.ts:20-24`), whereas the legacy `GET /api/areas/readable` spreads the whole
  `ReadableArea` (`app/api/areas/readable/route.ts:23`), which includes `legacySystemId`
  (`lib/areas/list.ts:21`). `clientShellResolver` reads `ra.legacySystemId` to produce the handle
  every card binds its data queries to (`components/dashboard/v4/node-view.tsx:84`). **A client moved
  onto `/api/v4/areas` as it stands would resolve `handle: null` for every area and render nothing but
  skeletons.** Decide in this PR: add the field, or state why not.
- `POST /api/v4/dashboards` writes a v3 descriptor (`app/api/v4/dashboards/route.ts:123`,
  `descriptor: emptyDashboardV3()`). That is correct while the column is NOT NULL; note it for PR 15.

### Proof

- All 12 handlers driven, with the output pasted into the PR body: status code + one line of shape per
  handler. A 401/404 is a FAILURE, not a pass — it means the middleware ate it.
- `npm test` shows a **higher** suite count; state the delta.
- Every scratch area/dashboard created on `liveone-dev` is deleted, and the ledger's "scratch entities"
  line is back to empty.

### Do NOT

- Do NOT use `x-claude: true`. The Clerk middleware runs `auth.protect()` at the edge and rewrites to
  a 404 before the handler sees the header; `/api/v4/*` is not in `publicRoutes`
  (`lib/route-matchers.ts:11-31`). Mint a real session JWT.
- Do NOT "fix" a v4 handler by making it match the legacy one where the clean-sheet deliberately
  differs (§9.2: `PUT` full-replace, plural `/shares`, `/grants` as `PUT`).
- Do NOT retire any legacy handler here.

**Depends on:** nothing. Runs beside PRs 3 and 4.

---

# PR 3 — The two pre-landable extractions

**Goal:** `DailyStripes.tsx` and `HeatmapPanel.tsx` exist as standalone presentation components, with
their current pages re-pointed at them and rendering identically.

Straight from [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md):136-142 — "pure
presentation, idiom-independent, touch no config-v4 surface".

### Inventory

- `app/labs/kinkora-hws/Timeline.tsx` — **363 lines**. Extract the SVG stripe renderer to
  `components/dashboard/DailyStripes.tsx` (`"use client"`); re-point the lab page at it.
- `components/HeatmapClient.tsx` — **431 lines**, reads `useSearchParams()` at `:59`. Extract the
  selector/palette/points-fetch logic to `components/heatmap/HeatmapPanel.tsx`; re-point the
  standalone page at it.

### Steps

1. Extract `DailyStripes`, props-only (no URL reads, no data fetching). Lab page becomes a thin caller.
2. Extract `HeatmapPanel` with `showDebug` / `enableKeyboardNav` / `pinnedSeries` / `palette` props as
   the plan describes. **Leave `useSearchParams()` in the page, not the panel** — a card cannot own a
   URL read (see PR 5's harness note and `lib/charts/useTemporalRange.ts:43`).
3. No behaviour change anywhere.

### Proof

Both pages render byte-identically before/after — screenshot or DOM diff, stated in the PR body.
Verification bar green.

### Do NOT

- Do NOT add the card types, catalog entries or config schemas here. That is PRs 19 and 20.
- Do NOT move the panels' data fetching into the extracted components if it is currently in the page.

**Depends on:** nothing. Runs beside PRs 2 and 4; unblocks 19 and 20.

---

# PR 4 — `TileView` / `TileId` move into `card-types.ts`

**Goal:** the tile vocabulary stops living in the v3 modules, so the 9 already-v4-native tile plugins
no longer import from `lib/dashboard/v3.ts`.

### Inventory — the whole v3 tie of the tile layer is two type imports

| Symbol     | Lives at                    | Imported by                                                                                                           |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `TileView` | `lib/dashboard/v3.ts:33`    | `components/dashboard/tiles/types.ts:10`, `components/dashboard/tiles/registry.tsx:8`, `lib/dashboard/v4-adapt.ts:17` |
| `TileId`   | `lib/dashboard/cards.ts:25` | `lib/capabilities/catalog.ts:31` (re-exported at `:33`, used at `:54,65,106,118`)                                     |

`TileRenderProps` (`components/dashboard/tiles/types.ts:13-24`) has **no `card` and no `section`** —
that is the measurement behind "9/9 tiles are already v4-native". `V4TileCell`
(`components/dashboard/v4/node-view.tsx:107-134`) already calls them with exactly those props,
bypassing the adapter entirely.

### Steps

1. Move `TileId` (the 8-member union) and `TileView` (`TileId | "oe-grid"`) into
   `lib/dashboard/card-types.ts`. Re-export from the old homes **only if** something still needs the
   old path; prefer updating the importers.
2. Update the five importers above.
3. `lib/dashboard/card-types.ts:19` and `:29` already carry comments pointing at the old homes —
   update them, do not leave a stale claim.

### Proof

Pure type move: `npm run type-check` green and the diff contains **no logic changes at all**. If
`npm test` output changes in any way other than a renamed import, something non-mechanical crept in.

### Do NOT

- Do NOT move `DashboardCardType` (`lib/dashboard/cards.ts:10`) here. It is the key of both live
  registries and of `CARD_CATALOG`'s `Record<CardId, …>`; re-keying is PR 7's job and doing it now
  makes PR 7's diff unreadable.
- Do NOT touch `V4_CARD_TYPES` (`lib/dashboard/card-types.ts:18-39`).

**Depends on:** nothing. Runs beside PRs 2 and 3; unblocks 5.

---

# PR 5 — The prop-equivalence harness

**Goal:** a test that captures the exact props each card/tile plugin receives, so PR 6's port is
provably behaviour-preserving without a pixel comparison.

### Why prop-level, not pixel-level

Four card plugins bottom out in chart.js on a `<canvas>` (zero DOM), `useTemporalRange`
(`lib/charts/useTemporalRange.ts:43`) calls `useSearchParams()` during render, and there is **no
jsdom and no @testing-library** in the repo. The leaf components are unchanged by PR 6, so **identical
props ⇒ identical pixels**. Mock the leaves to capture props and all 19 plugins become provable with
zero new dependencies.

### Steps

1. Create the test at **`lib/dashboard/__tests__/card-prop-equivalence.test.ts`** — a `.ts` file under
   a jest `root`. See "Two ways to write a test that is silently never run" above; **`.tsx` under
   `components/` is doubly uncollected.** Author the JSX via `React.createElement`, or keep a tiny
   `.tsx` fixture module (not a test file) that the `.test.ts` imports.
2. Render with `renderToStaticMarkup` from `react-dom/server` (present, v19.1.1).
3. `jest.mock` the leaves so each plugin's `Render` output is a props-capturing sentinel. Also mock:
   - `useAreaDatum` (`components/dashboard/cards/shared.tsx:70`) and the react-query surface it uses;
   - `next/navigation`'s `useSearchParams`, or `useTemporalRange` wholesale.
4. Drive the fixture through **both** paths for the same logical dashboard: the v3 path
   (`components/Dashboard.tsx`) and the v4 path (`components/dashboard/v4/node-view.tsx`), and assert
   the captured prop bags are equal.
5. Cover the five plugins that read something other than `handle` — they are the whole risk:
   `card.deviceSystemId` (`device-metrics.tsx:14`, `generator-runs.tsx:14`), `card.variant`
   (`device-metrics.tsx:24`), `card.chart` (`chart.tsx:42-46`, in `collapseKey`), `section.areaId`
   (`battery-provenance-history.tsx:26-27`), `card.tiles` (`tiles-card.tsx:69`).

### Proof

The harness is **green against today's code, unchanged** — that is its entire purpose. A harness
written after the port proves nothing. State the plugin count it covers in the PR body.

### Do NOT

- Do NOT install jsdom or @testing-library. The point is zero new dependencies.
- Do NOT assert on rendered markup for the canvas-backed cards; assert on captured props.
- Do NOT let the harness pass vacuously — a mock that swallows a missing prop reads as coverage. Assert
  the prop bag has the expected KEYS, not just that the render did not throw.

**Depends on:** PR 4 (landed). Blocks PR 6.

---

# PR 6 — `CardRenderProps` goes v4-native; delete `v4-adapt.ts`

**Goal:** card plugins take a v4 card node + resolved context instead of a synthesized `CardV3` /
`AreaSectionV3`, and the adapter is deleted.

### Inventory

The v3 residue in the card layer is **one interface and four call sites**:

- `CardRenderProps` — `components/dashboard/cards/types.ts:17-24`: `card: CardV3`, `section: AreaSectionV3`,
  `handle?: number`. `CardPlugin.collapseKey` (`:42`) also takes a `CardV3`.
- `lib/dashboard/v4-adapt.ts` — 82 lines: `TILE_VIEW_TYPES` (`:23`), `isTileViewType` (`:35`),
  `isV3CardType` (`:40`), `v4CardRenderKind` (`:45`), `synthCardV3` (`:56`), `synthSectionV3` (`:80`).
- Its only non-test consumer is `components/dashboard/v4/node-view.tsx`, which calls the synths at
  **`:171`, `:172`, `:241`, `:261`** (the orchestration ledger's ":179" is the `handle=` JSX prop line
  of the same element, not a call).
- `lib/dashboard/__tests__/v4-adapt.test.ts` — 105 lines, dies with the module.

**The 10 card plugins, and what each actually reads:**

| Plugin                       | File:line                                                            | Reads                                    |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| `amber-now`                  | `components/dashboard/cards/amber-now.tsx:9`                         | `handle`                                 |
| `amber-timeline`             | `components/dashboard/cards/amber-timeline.tsx:8`                    | `handle`                                 |
| `battery-contents`           | `components/dashboard/cards/battery-contents.tsx:14`                 | `handle`                                 |
| `ev-provenance`              | `components/dashboard/cards/ev-provenance.tsx:16`                    | `handle`                                 |
| `chart`                      | `components/dashboard/cards/chart.tsx:13` / `:42-46`                 | `handle`; `card.chart` in `collapseKey`  |
| `sankey`                     | `components/dashboard/cards/sankey.tsx:10-13`                        | **nothing** (`Render: () => null`)       |
| `device-metrics`             | `components/dashboard/cards/device-metrics.tsx:13-24`                | `card.deviceSystemId`, `card.variant`    |
| `generator-runs`             | `components/dashboard/cards/generator-runs.tsx:13-14`                | `card.deviceSystemId`                    |
| `battery-provenance-history` | `components/dashboard/cards/battery-provenance-history.tsx:18,26-27` | `section.areaId`                         |
| `tiles-card`                 | `components/dashboard/cards/tiles-card.tsx:64-95`                    | `card.tiles` — **NOT PORTED, see below** |

### 🛑 `tiles-card.tsx` is not ported — it is already unreachable from the v4 renderer

`"tiles"` is deliberately **absent** from `V4_CARD_TYPES` (`lib/dashboard/card-types.ts:18-39`; the
header at `:15` says so, and `lib/dashboard/v3-to-v4.ts:75-84` rewrites a v3 `tiles` card into a `row`
group). So `isKnownCardType("tiles")` is false → `isV3CardType("tiles")` is false →
`v4CardRenderKind("tiles")` returns `"unknown"` → `node-view.tsx:185-189` renders the **"Unknown card
type" placeholder**, never `tilesPlugin`. Its only live mount is through `components/Dashboard.tsx`.
**It dies in PR 9 with the v3 renderer.** Porting it here would be porting dead code.

That means the exhaustiveness `satisfies Record<DashboardCardType, CardPlugin>`
(`components/dashboard/cards/registry.tsx:37`) must keep a `tiles` entry until PR 9. Leave the plugin
in place, unported, with a comment naming PR 9.

### Steps

1. Re-shape `CardRenderProps` to `{ node: CardNode; context: NodeContext; handle?: number; areaId?: AreaId }`
   (exact shape is yours — the constraint is that no `CardV3`/`AreaSectionV3` appears).
   `collapseKey` takes the `CardNode`.
2. Port the 9 plugins. Six are trivial (they read `handle` or nothing). The three real ones:
   - `device-metrics` / `generator-runs`: `card.deviceSystemId ?? handle` → the resolved
     `device?.systemId ?? handle` that `node-view.tsx:155` already computes.
   - `chart`: `collapseKey` reads `node.config` instead of `card.chart` (the rewriter already puts the
     chart config there — `lib/dashboard/v3-to-v4.ts:91-94`).
   - `battery-provenance-history`: takes the resolved `areaId` directly. **Delete the
     `section.areaId.startsWith("device-")` branch (`:26`) — but read the note below first.**
3. Delete `lib/dashboard/v4-adapt.ts` and its test; inline `v4CardRenderKind`'s dispatch into
   `node-view.tsx` (or move it to `card-types.ts` — it is pure vocabulary).
4. `components/Dashboard.tsx` still exists and still renders v3. Give it a thin local adapter so it
   keeps compiling until PR 9 deletes it, OR keep the v3 renderer on a frozen copy of the old props.
   **Say which in the PR body** — this is the one place PR 6 can quietly break `/device/{id}`.

### ⚠️ The `device-` sentinel is NOT dead today

The plan calls `section.areaId.startsWith("device-")` "dead under v4". That is right about v4
(`synthSectionV3` can only ever emit the area uuid or `""` —
`lib/dashboard/v4-adapt.ts:80-82`) and **wrong about the live tree**: the sentinel has a producer at
`app/device/[...slug]/page.tsx:261` (`(await getAreaForDevice(device.id))?.id ?? \`device-${device.id}\``),
which feeds `components/Dashboard.tsx`via`DeviceViewer`. Under eager areas it should never fire, but
it is reachable code on a live path. Removing the consumer branch in PR 6 is safe **only because the
helper-device branch at `:24` takes precedence and PR 9 deletes the producer\*\* — state that argument
explicitly rather than deleting on the plan's say-so.

### Proof

**The PR 5 harness, unchanged, still green.** That is the whole proof and the reason PR 5 exists.
Plus: `/device/{id}` and a real `/dashboard/{…}` both driven by hand on dev.

### Do NOT

- Do NOT port `tiles-card.tsx`.
- Do NOT change any leaf component. If a leaf changes, the harness's "identical props ⇒ identical
  pixels" argument is void.
- Do NOT merge the two registries here. That is PR 7.

**Depends on:** PR 5 (landed). Blocks PR 7.

---

# PR 7 — One registry: `CARD_RENDERERS` on `CardType`, `NODE_CATALOG`

**Goal:** one render registry and one catalog, keyed on the unified v4 card vocabulary.

### Inventory — today there are two of each

| Thing            | Where                                           | Keyed on                                                        |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `CARD_RENDERERS` | `components/dashboard/cards/registry.tsx:26-37` | `DashboardCardType` (10 entries, incl. `tiles`)                 |
| `TILE_RENDERERS` | `components/dashboard/tiles/registry.tsx:20-30` | `TileView` (9 entries)                                          |
| `CARD_CATALOG`   | `lib/capabilities/catalog.ts:149`               | `CardId = DashboardCardType \| "oe-grid"` (`:132`)              |
| `TILE_CATALOG`   | `lib/capabilities/catalog.ts:65`                | `TileId` (`:106` `TILE_ORDER`, `:118` `availableTilesFromCaps`) |

`V4_CARD_TYPES` (`lib/dashboard/card-types.ts:18-39`) is the 18-member target union: 9 promoted tiles

- 9 card types, `tiles` excluded.

### Steps

1. Merge `TILE_RENDERERS` into `CARD_RENDERERS`, `satisfies Record<KnownCardType, CardPlugin>`. The
   two plugin contracts differ (`TileRenderProps` vs `CardRenderProps`) — unify them, or keep a
   discriminant on the plugin. Whichever: **the `satisfies` exhaustiveness check must survive**, since
   it is what turns "added a card type, forgot a renderer" into a compile error.
2. Merge `TILE_CATALOG` + `CARD_CATALOG` → `NODE_CATALOG: Record<KnownCardType, …>` in
   `lib/capabilities/catalog.ts`. Fold `TILE_ORDER` / `availableTilesFromCaps` /
   `availableAreaCards` / `availableDeviceCards` (`:106,118,234,243`) onto it.
3. Update `GET /api/v4/areas/{id}/eligibility` — `app/api/v4/areas/[id]/eligibility/route.ts:9-10,36,40,57`
   is the only non-test consumer of both catalogs. Its response shape changes (`areaCards` + `tiles`
   become one list, or stay split but read from one source). **PR 2 exercised this route — re-drive it.**
4. `lib/capabilities/__tests__/derive-equivalence.test.ts:19,144,177,207` reads `CARD_CATALOG.chart.requires`;
   `lib/capabilities/server.ts:115` does too. Update in lockstep.

### Proof

- PR 5's harness still green.
- `GET /api/v4/areas/{id}/eligibility` driven on dev, before/after payload diffed; only the intended
  keys move.
- The `satisfies` check is still present and still exhaustive — demonstrate by adding a bogus type
  locally and showing it fails to compile (do not commit that).

### Do NOT

- Do NOT relax `Record<…>` to `Partial<Record<…>>` to make the merge typecheck. That deletes the
  entire safety property of both registries.
- Do NOT change the catalog's capability requirements. This PR re-homes them; it does not re-decide
  eligibility.

**Depends on:** PR 6 (landed). Blocks PRs 8, 19, 20.

---

# PR 8 — `buildAreaStrategy` emits v4 directly

**Goal:** the seed builder returns a `DashboardV4`; `v4-seed.ts` stops taking the v3 detour.

### Inventory

`buildAreaStrategy(ctx): DashboardV3` — `lib/capabilities/strategy.ts:54` (imports `CardV3`,
`DashboardV3`, `TileV3` at `:21`) → `buildAreaStrategyForHandle` — `lib/capabilities/server.ts:136-147`.

**Four consumers:**

| Consumer                              | File:line                                            | Fate                              |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `POST /api/dashboards`                | `app/api/dashboards/route.ts:68`                     | deleted in PR 13                  |
| `GET /api/areas/{id}/default-section` | `app/api/areas/[areaId]/default-section/route.ts:37` | deleted in PR 13 (v4 twin exists) |
| `/device/{id}` page                   | `app/device/[...slug]/page.tsx:262`                  | ported in PR 9                    |
| `lib/dashboard/v4-seed.ts:35`         | calls it, then `rewriteV3ToV4` at `:48`              | **the v3 detour this PR removes** |

Golden test: `lib/capabilities/__tests__/strategy-equivalence.test.ts:131-135` — 137 lines, asserts
`buildAreaStrategy(c.ctx)` equals a v3-shaped fixture.

### Steps

1. Change `buildAreaStrategy` to build v4 nodes directly (group per section, `row` group for the tiles
   container, `card` leaves — the exact mapping `lib/dashboard/v3-to-v4.ts:59-111` performs today; port
   it, do not call it).
2. `buildSeedDoc` (`lib/dashboard/v4-seed.ts:31-49`) becomes a thin wrapper: build v4, resolve device
   pins, done. `devicePins` (`:18-29`) currently walks a `DashboardV3` — re-point it at the node tree
   (or at `collectRefs`).
3. Re-golden `strategy-equivalence.test.ts` against the v4 output. **Re-golden deliberately, with the
   old and new fixtures diffed in the PR body** — a golden test rewritten to match whatever the code
   now emits is a tautology.
4. The three remaining v3 consumers need a v4→v3 shim for one PR (or PR 9 lands first — see below).
   State which you chose.

### Proof

- The re-goldened test, with the v3↔v4 fixture correspondence shown card-for-card.
- `GET /api/v4/areas/{id}/default-group` driven on dev for a multi-device area (Daylesford, 4 members)
  and a single-device area; output compared against `GET /api/areas/{id}/default-section` rewritten
  through `rewriteV3ToV4`. They must agree — that is the equivalence this PR is allowed to assume.

### Do NOT

- Do NOT delete `rewriteV3ToV4` here. `lib/dashboard/dashboards.ts:344` (the descriptor PATCH) and
  `app/api/dashboards/route.ts` still call it; it dies in PR 16.
- Do NOT change what the strategy DECIDES (which cards for which capabilities). This PR changes the
  output shape only.

**Depends on:** PR 7 (landed). Blocks PR 9.

---

# PR 9 — Port `/device/{id}`; delete `Dashboard.tsx` and `tiles-card.tsx`

**Goal:** the second live v3 render path goes away, and with it the v3 renderer.

**This is the PR the execution plan does not know about.** See "TWO live v3 render paths" above.

### Inventory

- `app/device/[...slug]/page.tsx` — `:20` imports `DashboardV3`; `:257` declares `descriptor`; `:262`
  builds it; `:278-280` feeds `hasTimeTravelingCard`; `:296` and `:320` pass it to `<DeviceViewer>`.
- `components/DeviceViewer.tsx` — 173 lines; `:9` imports `Dashboard`; `:50` types the prop; `:169`
  renders `<Dashboard descriptor={descriptor} areaById={areaById} areasResolved />`.
- `components/Dashboard.tsx` — **242 lines**, exactly two importers (`DeviceViewer.tsx:9`,
  `DashboardClient.tsx:8`).
- `components/dashboard/cards/tiles-card.tsx` — 3,009 bytes; registered at
  `components/dashboard/cards/registry.tsx:27`.
- `lib/dashboard/temporal-cards.ts` — 61 lines; `hasTimeTravelingCard` (`:37-49`) and `primaryHandle`
  (`:55-61`) both walk a `DashboardV3`. Consumers: `components/DashboardClient.tsx:119,120` and
  `app/device/[...slug]/page.tsx:278`. Its `tiles` branch (`:25-30`) inspects `card.tiles` for
  `hotWater` / `renewables` — under v4 those are sibling cards in a `row` group, so the walk changes
  shape, not just types.

### Steps

1. `app/device/[...slug]/page.tsx` builds a `DashboardV4` (PR 8 made the builder emit one) and passes
   it to `DeviceViewer`.
2. `DeviceViewer` renders `<DashboardV4View>` (`components/dashboard/v4/node-view.tsx:374`). It needs
   an `areaById` map keyed by `ar_` and a `deviceById` map — `clientShellResolver` (`:69-90`) is the
   contract; note it reads `ra.legacySystemId` at `:84`.
3. Rewrite `temporal-cards.ts` to walk a `DashboardV4`: recurse the node tree, treat each promoted tile
   as a card, and keep the `chartCapable` gating identical. Update both consumers.
4. **Delete `components/Dashboard.tsx`** and **`components/dashboard/cards/tiles-card.tsx`**; remove
   the `tiles` entry from `CARD_RENDERERS` and drop `"tiles"` from `DashboardCardType` if nothing else
   needs it. Collapse the never-taken ternary at `components/DashboardClient.tsx:230-246` to the
   `<DashboardV4View>` arm.
5. `lib/capabilities/catalog.ts:5` and `lib/dashboard/temporal-cards.ts:6` both name
   `components/Dashboard.tsx` in prose. Fix the comments; do not leave a claim about a deleted file.

### Proof

- `/device/{id}` driven for **at least four shapes** on dev: a Selectronic site, the Sigenergy device
  whose handle collides with an area (handle 13), the DSE genset (device 14 — the `generator-runs`
  card), and a device with a `hotWater` tile (Kinkora). Screenshot each before/after.
- The header temporal navigator appears/disappears in exactly the same cases as before — that is
  `hasTimeTravelingCard`, and it is the thing most likely to silently invert.
- `grep -rn "components/Dashboard" app components lib scripts` returns nothing but this doc.

### Do NOT

- Do NOT delete `lib/dashboard/v3.ts` here. `descriptor` is still NOT NULL and still read (PRs 14–16).
- Do NOT change `/device/{id}`'s access-denied or no-device render paths — they never used the
  descriptor (`app/device/[...slug]/page.tsx:256` says so).
- Do NOT let the tiles grid regress: a v3 `tiles` card is a `row` group, and `row` is a **grid** of
  equal columns, not a flex row (`components/dashboard/v4/node-view.tsx:289-308`).

**Depends on:** PR 8 (landed). Blocks PR 13's `/device` clients and PR 14.

---

# PR 10 — The 7 legacy area mutations get v4 twins

**Goal:** every area mutation has a `/api/v4` address. Legacy handlers stay live; nothing is retired.

### Inventory — the 7 legacy handlers, and the 6 v4 handlers they become

| Legacy                                      | File:line                                                 | v4 target (§9.2)                                 |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `POST /api/areas`                           | `app/api/areas/route.ts:102`                              | `POST /api/v4/areas`                             |
| `PATCH /api/areas/{id}`                     | `app/api/areas/[areaId]/route.ts:71`                      | `PATCH /api/v4/areas/{id}`                       |
| `DELETE /api/areas/{id}`                    | `app/api/areas/[areaId]/route.ts:114`                     | `DELETE /api/v4/areas/{id}`                      |
| `POST /api/areas/{id}/devices`              | `app/api/areas/[areaId]/devices/route.ts:25`              | `PUT /api/v4/areas/{id}/members` ⎫               |
| `DELETE /api/areas/{id}/devices`            | `app/api/areas/[areaId]/devices/route.ts:73`              | `PUT /api/v4/areas/{id}/members` ⎭ **one route** |
| `PUT /api/areas/{id}/bindings`              | `app/api/areas/[areaId]/bindings/route.ts:52`             | `PUT /api/v4/areas/{id}/bindings`                |
| `POST /api/areas/{id}/recompute-provenance` | `app/api/areas/[areaId]/recompute-provenance/route.ts:46` | `POST /api/v4/areas/{id}/recompute-provenance`   |

`GET /api/v4/areas/{id}` already exists (`app/api/v4/areas/[id]/route.ts:15`) — add the PATCH and
DELETE to that file.

### Steps

1. Build the six handlers. Reuse the existing service layer (`lib/areas/*`) — this is a wire port, not
   a rewrite of area semantics.
2. `PUT …/members` is **declarative full-replace**: the server diffs, applies transactionally,
   refreshes derived state (`refreshAreaServing` → `buildSubscriptionRegistry`), and returns the new
   state. That is the §9.2 contract for every collection.
3. 🛑 **Route-matcher entries.** Middleware runs BEFORE `next.config` rewrites and sees the original
   path. `recompute-provenance` is in `publicRoutes` (`lib/route-matchers.ts:27`) because it
   authenticates by `CRON_SECRET` in-handler. **Its v4 twin needs its own entry** or a headless
   `CRON_SECRET` call 404s at the edge — invisible to a logged-in tester. Add
   `"/api/v4/areas/(.*)/recompute-provenance"` and extend `lib/__tests__/route-matchers.test.ts`.
4. **Drive every new handler.** Extend `scripts/utils/v4-surface-smoke.ts` from PR 2.

### Proof

- Each of the six driven end-to-end on dev with a real JWT, creating and then deleting its own scratch
  area. Paste status + payload shape per handler.
- ⚠️ **A DELETE predicate must be driven POSITIVELY.** For `PUT …/members`, prove the removal leg on a
  **two-member area with a binding on each** — `area-builder-smoke.ts` historically cleared bindings
  before removing a member, so its remove ran against zero rows and proved only that the SQL parses.
- The legacy handlers still work unchanged.

### Do NOT

- Do NOT delete or modify any legacy handler. PR 13 does that.
- Do NOT move any client onto these routes yet.
- Do NOT skip the route-matcher entry because "it worked in my browser".

**Depends on:** PR 2 (landed). Runs beside PRs 11 and 12. Blocks PR 13.

---

# PR 11 — The 5 sharing mutations + their 2 reads

**Goal:** grants and share tokens have v4 addresses.

### Inventory

| Legacy                               | File:line                                     | v4 target (§9.2)                                     |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------------------- |
| `GET /api/dashboards/{id}/grants`    | `app/api/dashboards/[id]/grants/route.ts:44`  | `GET /api/v4/dashboards/{id}/grants`                 |
| `POST /api/dashboards/{id}/grants`   | `app/api/dashboards/[id]/grants/route.ts:83`  | `PUT /api/v4/dashboards/{id}/grants` ⎫               |
| `DELETE /api/dashboards/{id}/grants` | `app/api/dashboards/[id]/grants/route.ts:121` | `PUT /api/v4/dashboards/{id}/grants` ⎭ **one route** |
| `GET /api/dashboards/{id}/share`     | `app/api/dashboards/[id]/share/route.ts:41`   | `GET /api/v4/dashboards/{id}/shares`                 |
| `POST /api/dashboards/{id}/share`    | `app/api/dashboards/[id]/share/route.ts:52`   | `POST /api/v4/dashboards/{id}/shares`                |
| `DELETE /api/dashboards/{id}/share`  | `app/api/dashboards/[id]/share/route.ts:76`   | `DELETE /api/v4/dashboards/{id}/shares`              |
| `PATCH /api/dashboards/{id}/share`   | `app/api/dashboards/[id]/share/route.ts:90`   | `PATCH /api/v4/dashboards/{id}/shares`               |

Note the **plural** `shares` — §9.2 renames it. And `grants` becomes a single `PUT` full-replace, so
7 legacy handlers become **5** v4 handlers.

### Steps

1. Build the five. `loadOwnedDashboard` (`lib/dashboard/v4-routes.ts:19-39`) is the existing auth
   helper — reuse it; it already mirrors the v3 route's `loadOwned`.
2. `PUT …/grants` takes the full member list and diffs.
3. Share tokens are the **one genuine multi-party surface** in this system (everything else is
   single-user). Revocation must be exact: a `DELETE` that under-deletes leaves a live token.

### Proof

- All five driven on dev. For `DELETE …/shares`, mint two tokens, revoke one, and prove **the other
  still resolves** — an over-delete and an under-delete look identical from the caller.
- 🛑 A share token authorizes an **anonymous** reader. After any grants/share change, load the shared
  dashboard in a logged-out browser context with `?access=` and confirm it still renders. Nothing in
  the test suite covers that.
- Scratch tokens deleted at the end.

### Do NOT

- Do NOT retire the legacy handlers. PR 13.
- Do NOT add `/api/v4/dashboards/(.*)` to `shareableRoutes`. These are owner-only management routes;
  the share-token bypass must never reach a mutation (`lib/route-matchers.ts:43-54` explains the
  boundary).

**Depends on:** PR 2 (landed). Runs beside PRs 10 and 12. Blocks PR 13.

---

# PR 12 — The 4 orphan area reads (and the subtle route-matcher coupling)

**Goal:** the last legacy reads with no v4 address get one, so the whole legacy tree can be deleted in
PR 13.

### Inventory — the plan says 7; it is 4

| Legacy read                                 | File:line                                               | Status                                                                                               |
| ------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/areas?systemId=`                  | `app/api/areas/route.ts:38`                             | **DEAD** — no in-repo caller                                                                         |
| `GET /api/areas/{id}/bindings`              | `app/api/areas/[areaId]/bindings/route.ts:20`           | **DEAD** — bindings arrive inside the `GET /api/areas/{id}` payload; `BindingsTab.tsx:118` only PUTs |
| `GET /api/dashboards/{id}`                  | `app/api/dashboards/[id]/route.ts:44`                   | **DEAD** — only `app/api/dashboards/__tests__/dashboards-crud.integration.test.ts` calls it          |
| `GET /api/areas/candidate-devices`          | `app/api/areas/candidate-devices/route.ts:10`           | **PORT** — `components/area-builder/AreaBuilderDialog.tsx:103`                                       |
| `GET /api/areas/by-handle/{legacySystemId}` | `app/api/areas/by-handle/[legacySystemId]/route.ts:20`  | **PORT**                                                                                             |
| `GET /api/areas/{id}/provenance-daily`      | `app/api/areas/[areaId]/provenance-daily/route.ts:44`   | **PORT** — `lib/queries/provenanceDaily.ts:32`                                                       |
| `GET /api/areas/{id}/provenance-summary`    | `app/api/areas/[areaId]/provenance-summary/route.ts:31` | **PORT**                                                                                             |

(`GET /api/areas/readable` and `GET /api/dashboards` DO have v4 twins — but see the `legacySystemId`
shape gap flagged in PR 2. `GET /api/areas/{id}` and `GET /api/areas/{id}/default-section` have twins
too.)

### 🛑 The subtle one: each v4 twin needs its own `lib/route-matchers.ts` entry

Middleware runs `auth.protect()` at the edge **before** anything else and sees the original path.
Today:

| Legacy path              | Matcher list                              | Entry                      |
| ------------------------ | ----------------------------------------- | -------------------------- |
| `…/recompute-provenance` | `publicRoutes` (`CRON_SECRET` in-handler) | `lib/route-matchers.ts:27` |
| `…/provenance-summary`   | `publicRoutes` (same)                     | `lib/route-matchers.ts:28` |
| `/api/areas/by-handle/…` | `publicRoutes` (same)                     | `lib/route-matchers.ts:29` |
| **`…/provenance-daily`** | **`shareableRoutes`**                     | `lib/route-matchers.ts:60` |

**`provenance-daily` is the trap.** It is fetched by the battery-provenance history panel, which an
**anonymous `?access=` viewer** loads. Its v4 twin without a `shareableRoutes` entry works perfectly
for a logged-in tester and 404s at the edge for every shared-dashboard viewer. Add
`"/api/v4/areas/(.*)/provenance-daily"` to `shareableRoutes` and the three public ones to
`publicRoutes`, and extend `lib/__tests__/route-matchers.test.ts` (`:35-37,57-58,91` are the existing
cases to mirror).

### Steps

1. Build the four v4 reads. `loadReadableArea` (`lib/areas/http.ts`) is the existing readable-area auth
   helper — `app/api/v4/areas/[id]/default-group/route.ts:20` shows the pattern.
2. `by-handle` is a `legacy_handles` lookup; keep it, the handle alias is permanent.
3. Add the four matcher entries **in the same PR**, with tests.
4. **Delete the three dead reads** — or state in the PR body why each is kept. Deleting them here makes
   PR 13 smaller. `GET /api/dashboards/{id}`'s only caller is an integration test; retire the test with
   the route or re-point it.

### Proof

- Each v4 read driven authenticated.
- 🛑 **`provenance-daily`'s v4 twin driven ANONYMOUSLY with a real `?access=` token.** That is the only
  test that distinguishes a correct matcher entry from a missing one.
- `npm test` — `route-matchers.test.ts` must gain cases, not just pass.

### Do NOT

- Do NOT put a mutation route in `publicRoutes` or `shareableRoutes` (`lib/route-matchers.ts:22-29`
  explains why the existing entries are deliberately suffix-surgical).
- Do NOT assume a matcher entry is unnecessary because the route "is authed anyway" — the edge rewrite
  happens first and returns 404, not 401.

**Depends on:** PR 2 (landed). Runs beside PRs 10 and 11. Blocks PR 13.

---

# PR 13 — Move the clients onto v4, and DELETE the legacy trees

**Goal:** `app/api/areas/*` and `app/api/dashboards/*` are gone — 28 handlers, 15 route files,
1,743 LOC.

**May split into 13a (move the clients) / 13b (delete the routes).** Splitting is the safer default:
13a is revertible per-client, 13b is one atomic deletion whose proof is "grep finds no caller".

### Inventory — the client surface

| Module                                                      | LOC       | Calls                                                                                                                      |
| ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `components/area-builder/AreaBuilderDialog.tsx`             | 536       | `:103` candidate-devices, `:110` areas/{id}, `:152` POST areas, `:185`/`:208` PATCH/DELETE areas/{id}, `:230` POST devices |
| `components/DashboardSettingsDialog.tsx`                    | 421       | `:72,77,87,93` share; `:141` PATCH dashboards/{id}; `:166` DELETE                                                          |
| `components/area-builder/BindingsTab.tsx`                   | 257       | `:118` PUT bindings                                                                                                        |
| `components/NewDashboardDialog.tsx`                         | 192       | `:67` POST dashboards                                                                                                      |
| `components/AddAreaDialog.tsx`                              | 180       | `:72` default-section, `:83` PATCH dashboards/{id} — **PR 14 owns this one**                                               |
| `components/GrantsPanel.tsx`                                | 159       | `:37,61,88` grants                                                                                                         |
| `components/area-builder/MembersTab.tsx`                    | 103       | (via the dialog)                                                                                                           |
| `components/area-builder/types.ts`                          | 79        | the wire shapes                                                                                                            |
| `lib/queries/provenanceDaily.ts`                            | 48        | `:32` provenance-daily                                                                                                     |
| `components/dashboard/cards/battery-provenance-history.tsx` | 45        | via `BatteryProvenancePanel`                                                                                               |
| `lib/areas/recompute-flow.ts`                               | 40        | `:19` recompute-provenance                                                                                                 |
| `lib/queries/dashboards.ts`                                 | 39        | `:34` GET dashboards                                                                                                       |
| `lib/queries/areas.ts`                                      | 23        | `:18` GET areas/readable                                                                                                   |
| **subtotal**                                                | **2,122** |                                                                                                                            |
| `app/dashboard/[...slug]/page.tsx`                          | 398       | no fetch; consumes the shapes + SSR-prefetches                                                                             |
| `components/DashboardClient.tsx`                            | 285       | no fetch; consumes the shapes                                                                                              |
| **total**                                                   | **2,805** | ("~2,800 LOC of clients" — correct, but two of them do no fetching)                                                        |

### 🛑 The shape gap that will bite

`GET /api/v4/areas` returns `{id, displayName, chartCapable}` (`app/api/v4/areas/route.ts:20-24`).
`lib/queries/areas.ts:18` expects the whole `ReadableArea` **including `legacySystemId`**
(`lib/areas/list.ts:21`), which `clientShellResolver` reads at
`components/dashboard/v4/node-view.tsx:84` to produce the handle every card binds to. Move
`readableAreasQuery` onto `/api/v4/areas` without widening the payload and **every card renders a
skeleton forever**. PR 2 should already have fixed this; re-check before you start.

### Steps

1. Move each client onto its v4 twin, one commit per client, in this order: `GrantsPanel` →
   `DashboardSettingsDialog` → `NewDashboardDialog` → `lib/queries/*` → `area-builder/*`. Leave
   `AddAreaDialog` for PR 14.
2. Update `components/area-builder/types.ts` — it "mirrors the verified `/api/areas/*` response
   contract exactly" (`:4`); it now mirrors v4's.
3. Delete `app/api/areas/` and `app/api/dashboards/` entirely, plus
   `app/api/dashboards/__tests__/dashboards-crud.integration.test.ts` (or re-point it at v4).
4. Remove the legacy `lib/route-matchers.ts` entries (`:27,28,29,60`) — PR 12 added their v4
   replacements. **Keep `:69` (`/api/system/(.*)`)** — that is PR 18's, and it is a different shim.
5. `rm -rf .next-build` before `type-check` — route deletions leave a stale route validator.

### Proof

- `grep -rn "/api/areas\|/api/dashboards" app components lib hooks scripts` returns only comments and
  this doc. Raw-string grep, not tsc — **`tsc` cannot see a URL in a template literal.**
- Every moved client exercised in a browser on dev: create an area, add a member, edit bindings, create
  a dashboard, share it, revoke the share, delete the dashboard, delete the area.
- The anonymous `?access=` shared view still renders the battery-provenance panel.
- Verification bar green.

### Do NOT

- Do NOT delete a legacy route before its client has moved AND been driven. `tsc` will not tell you.
- Do NOT move `AddAreaDialog` here.
- Do NOT remove `/api/system/(.*)` from `shareableRoutes` — it is a different shim with a different
  expiry (PR 18), and `lib/route-matchers.ts:61-69` says so.

**Depends on:** PRs 10, 11, 12 (all landed), and PR 9 for the `/device` clients. Blocks PR 14.

---

# PR 14 — `AddAreaDialog` onto the doc: the last `descriptor` author

**Goal:** after this PR, **nothing authors `descriptor`** from a client.

### Why it defuses a live hazard

`lib/dashboard/dashboards.ts:331-355` regenerates `doc` from `descriptor` **unconditionally** on every
descriptor PATCH. The code's own comment (`:337-344`) says this is safe "only while `doc` has no
independent author" — and that the moment a v4 editor writes `doc` directly, a descriptor PATCH will
**clobber v4-authored structure**. `PUT /api/v4/dashboards/{id}` is that independent author, and it
already exists (`app/api/v4/dashboards/[id]/route.ts:47`). Retiring the last descriptor PATCH is what
makes the hazard unreachable without having to build a reject-or-merge policy.

**`AddAreaDialog` is the only client that writes `descriptor`** — measured: `DashboardSettingsDialog`'s
PATCH sends `displayName`/`alias` only (`components/DashboardSettingsDialog.tsx:141`).

### Inventory

`components/AddAreaDialog.tsx` — 180 lines. `:47` `sectionAreaIdsV3(descriptor)` for the
already-on-dashboard filter; `:72` `GET /api/areas/{id}/default-section`; `:79-82` appends the section;
`:83-87` `PATCH /api/dashboards/{id}` with `{descriptor: next}`.

Its `descriptor` prop comes from `components/DashboardClient.tsx:266`.

### Steps

1. `:72` → `GET /api/v4/areas/{id}/default-group` (`app/api/v4/areas/[id]/default-group/route.ts:15`),
   which returns `{ group }` — a v4 `GroupNode`.
2. `:83` → `PUT /api/v4/dashboards/{id}` with the whole doc, `If-Match` on the revision (§9.1). Append
   the group to `doc.root.children`.
3. `:47` → walk the doc's `area` refs (`collectRefs` in `lib/dashboard/v4-validate.ts`) instead of
   `sectionAreaIdsV3`.
4. `DashboardClient` passes `doc`, not `descriptor` — `:40` (the prop type), `:242`, `:258`, `:266`.
5. `components/DashboardClient.tsx:119-120` still call `hasTimeTravelingCard`/`primaryHandle`; PR 9
   already made those v4-native.

### Proof

- Add an area to a dashboard via the UI on dev, then read the row back and confirm **`descriptor` did
  not change** while `doc` did, and `revision` advanced by exactly 1.
- Do it twice concurrently (two tabs) and confirm the second gets a **412**, not a silent clobber.
  That is the whole point of `If-Match` and it has never been exercised.
- `grep -rn "descriptor" components app --include-clients` shows no client writer left.

### Do NOT

- Do NOT drop the descriptor column, or stop the server writing it. PRs 15 and 16.
- Do NOT skip `If-Match` "because Simon is the sole user". Two browser tabs are two writers.

**Depends on:** PRs 9 and 13 (landed). Blocks PR 15.

---

# PR 15 — Stop reading and writing `descriptor` (the column stays, inert)

**Goal:** no code path reads or writes `dashboards.descriptor`. The column is left in place.

### 🛑 The method is the point: delete the field from `schema.ts` FIRST

**A projection-less `.select()` is invisible to every grep.** `lib/dashboard/dashboards.ts:140` selects
`descriptor: dashboards.descriptor` explicitly — but Phase 13 lost eight hours to
`lib/admin/get-areas-data.ts`, which read a doomed field off a `select().from(areas)` that named no
columns, survived a ~48-site sweep and every raw-string grep, and surfaced **only** when the field was
deleted from `schema.ts`.

So: **step 1 is `git rm` the field at `lib/db/planetscale/schema.ts:532` and let `tsc` enumerate the
readers.** That list is the only complete inventory. Everything below is a starting point, not the
answer.

### Inventory (grep-visible readers/writers — expect `tsc` to find more)

**Writers:**

- `lib/dashboard/dashboards.ts:76` (`createDashboard`), `:140` (the select projection), `:331-355`
  (the PATCH + unconditional `doc` regeneration + `revision` bump)
- `app/api/dashboards/route.ts:79` — deleted by PR 13
- **`app/api/v4/dashboards/route.ts:123`** — `descriptor: emptyDashboardV3()`. A **v4** route writes
  it, because the column is NOT NULL. Easy to miss when reasoning "v4 doesn't touch descriptor".
- `app/api/dashboards/[id]/route.ts:85-121` — deleted by PR 13

**Readers:**

- `app/dashboard/[...slug]/page.tsx:78-79` (`isDashboardV3(raw)`)
- `components/DashboardClient.tsx:40,119,120,242,258,266` — mostly gone after PR 14
- `lib/api-auth.ts:249`, `lib/dashboard/grants.ts:121`, `lib/dashboard/access.ts:34,65`
- `lib/dashboard/composition.ts:77` (`descriptorAreaIds`), `:17` (`emptyDashboardV3`)
- `lib/dashboard/dashboards.ts:127,254,263-266` (the `cardCount` v3 branch)
- `lib/admin/get-dashboards-data.ts:109-110` (`isDashboardV3` + `allCardsV3`)

### Steps

1. Delete the `schema.ts` field. Compile. Fix what `tsc` names, top-down.
2. Every `isDashboardV3(x) ? … : …` becomes the v4 arm only. `cardCount` counts doc nodes.
3. **Make the column writable-without-code:** the migration in PR 16 drops it, but between this deploy
   and that migration the column is still NOT NULL. Either give it a DB-level `DEFAULT '{}'::jsonb` (a
   tiny separate DDL the orchestrator numbers), or keep exactly one writer that supplies a constant.
   **Decide and state it** — this is the expand/contract seam and getting it wrong 500s every dashboard
   create between the two deploys.
4. Hand-run the raw-SQL grep: `grep -rn "descriptor" lib/readings/ lib/db/` — `prod-dev-sync.ts` builds
   literal SQL from a manifest and is invisible to `tsc`
   (`lib/readings/__tests__/prod-dev-sync.test.ts` pins it).

### Proof

- `tsc` green with the field gone from `schema.ts`.
- Create a dashboard, edit it, share it, delete it — on dev, through the UI — with the column still
  present. Then read the row: `descriptor` unchanged from whatever step 3 chose.
- The prod→dev sync (`npm run db:sync-dev-db`) runs to exit 0. It reads columns at runtime.

### Do NOT

- Do NOT drop the column here. **Drops invert the ordering rule**: the code that stops referencing a
  column must be DEPLOYED first, because a projection-less `.select()` expands to the columns declared
  in the _running_ build. That applies to `liveone-dev` as much as prod.
- Do NOT delete `lib/dashboard/v3.ts` yet — PR 16.

**Depends on:** PR 14 (landed). Blocks PR 16, which additionally requires PR 15 **DEPLOYED**.

---

# PR 16 — Migration 0053: DROP `dashboards.descriptor`

**Goal:** the column goes, and the v3 modules go with it.

### 🛑 Precondition: PR 15 must be DEPLOYED, not merely merged

To prod **and** to `liveone-dev` (shared infrastructure; every `main`-based build there reads the
schema too). Confirm the running builds, not the branch.

### Backup first — this is not a row-count inventory

`descriptor` is a jsonb column that is **not reconstructible from `doc` in general** (the rewrite is
lossy in the other direction). Before applying:

```
pg_dump --data-only --table=dashboards   # BOTH environments
```

into gitignored `.context/backups/`. **That dump carries config and the repo is PUBLIC.** A row count
is not a backup.

### The migration

House style: copy `drizzle-planetscale/0051_terminal_drop_systems_point_info_polling_status.sql`.

One `DO $$ … RAISE EXCEPTION` block reading **`pg_catalog`, never the drizzle journal**, asserting:

- the column still exists (catches a partial/duplicate apply);
- **every row has a non-null `doc` that passes a shape sanity check** — the asymmetric assertion:
  assert only the losing direction (a dashboard with no usable `doc` must abort the drop);
- zero unexpected dependents on the column (`pg_constraint` scoped by `conrelid`; also check
  `pg_attrdef` and any index).

Then `ALTER TABLE dashboards DROP COLUMN descriptor`. **No `CASCADE` anywhere** — an unexpected
dependent must abort, not vanish.

⚠️ `db:pg:migrate` swallows `RAISE NOTICE`, so capture the inventory by hand first or the record is lost.

### Also deleted in this PR

- `lib/dashboard/v3.ts` (164 lines), `lib/dashboard/cards.ts` (33), `lib/dashboard/v3-to-v4.ts` (111)
- `lib/dashboard/__tests__/v3-to-v4.test.ts` (180) + `lib/dashboard/__tests__/v4-adapt.test.ts` (105)
  — **285 LOC of strictly-bridge tests**, not the plan's "~362". `v3.test.ts` (54) and
  `dashboards-read-normalize.test.ts` (83) go too if their subjects are gone; decide each explicitly.
- Every `isDashboardV3` / `isDashboardV4` branch. `isDashboardV4` (`lib/dashboard/v4.ts:87`) survives
  as a shape guard if `doc` is still `jsonb`; `isDashboardV3` does not.
- `lib/dashboard/v4-seed.ts`'s residual v3 imports (`:7,8`) if PR 8 left any.

### Apply procedure

Standard manual migration, **no window**: merge → deploy `Ready` → apply **prod first, then dev** →
post-check the **CATALOG** → `db:pg:generate` must say _No schema changes_. Use a short-TTL
`pscale role`, then reassign + delete it (the table-ownership trap).

🛑 **`db:pg:migrate` prints "applied successfully" from a checkout that LACKS the migration file.**
Confirm `drizzle-planetscale/` actually contains `0053_*` in the checkout you are applying from, and
post-check `information_schema.columns` — never the migrate output.

### Proof

- `SELECT column_name FROM information_schema.columns WHERE table_name='dashboards'` on both
  environments: no `descriptor`.
- `/dashboard/{user}/{slug}`, `/dashboard/id/{n}` (the legacy 301 — that is `dashboards.legacy_id`, a
  **different** column, unaffected), and `/device/{id}` all render.
- `npm run db:sync-dev-db` exit 0.
- `grep -rn "descriptor" lib/dashboard app/dashboard components` returns nothing but Amber's unrelated
  price `descriptor` (`lib/vendors/amber/types.ts:49,68`, `lib/amber-utils.ts:55`).

### Do NOT

- Do NOT `CASCADE`.
- Do NOT run `db:pg:generate` to get the number. **0053 is assigned.**
- Do NOT confuse this with `dashboards.legacy_id`, which is a **permanent** shim.

**Depends on:** PR 15 DEPLOYED. Blocks PR 22.

---

# PR 17 — The `/api/data` `vendorSiteId` raw-uuid leak (migration 0054)

**Goal:** no raw area uuid crosses the wire.

### The leak, precisely

An area's helper device is minted with `vendorSiteId = \`helper:area:${areaId}\``where`areaId`is the
**raw uuid** —`lib/areas/helper-site-id.ts:12`, called from `lib/areas/helper.ts:52`. `/api/data`emits`vendorSiteId` verbatim on the device leg (`lib/dashboard/serve-data.ts:169`, typed at `:74`),
and `components/dashboard/cards/battery-provenance-history.tsx:24-25`parses the uuid back out with`parentAreaIdFromHelperSiteId`. `lib/areas/ref.ts:24-27` names this as the third live raw-uuid producer
and says the honest fix is a data migration.

The regex is `/^helper:area:([0-9a-fA-F-]{36})$/` — `lib/areas/helper-site-id.ts:8`.

### Steps — expand/contract, decoder first

1. **Deploy the dual-accept decoder first.** `parentAreaIdFromHelperSiteId` accepts **both**
   `helper:area:<uuid>` and `helper:area:ar_…`, returning `ar_` in both cases. `helperSiteId` starts
   minting `ar_`. Update `lib/areas/__tests__/helper-site-id.test.ts` (it pins the uuid form at
   `:11,20,25,26,29,33,36,37`).
2. **Then migration 0054** — `UPDATE devices SET vendor_site_id = 'helper:area:' || <ar_ encoding>`
   for every row where `vendor_site_id LIKE 'helper:area:%'` and the tail is a uuid. The TypeID
   encoding is Crockford-base32 of the uuid: either compute it in SQL, or make 0054 a no-op DDL guard
   and do the rewrite in a driven one-shot script whose result the migration then **asserts** (a
   `DO`/`RAISE EXCEPTION` that aborts if any `helper:area:<uuid>` row remains). The second shape is
   safer — do not hand-roll base32 in plpgsql.
3. **Then** make the decoder strict, in a later PR or a follow-up commit after the migration is applied
   to both environments. Do not collapse steps 1 and 3.
4. `devices.vendor_site_id` has a uniqueness expectation (`fetchByVendorSite`,
   `lib/registry/device-config.ts:208-210`) — confirm the rewrite cannot collide.

### Also check while you are here

`components/dashboard/tiles/types.ts:16` — the `oe-grid` tile reads `device.vendorSiteId` off the same
payload for its NEM region. That is a **vendor-literal** value (`NSW1`/`VIC1`), not an id; leave it.

### Proof

- Before/after `/api/data` payload for the battery-provenance area, with the `vendorSiteId` field shown.
- The battery-provenance history panel renders on `/device/{helper}` **and** on the area dashboard
  **and** in an anonymous `?access=` shared view.
- Catalog post-check on both environments: `SELECT count(*) FROM devices WHERE vendor_site_id ~ '^helper:area:[0-9a-fA-F-]{36}$'`
  → 0.
- The prod→dev sync runs green afterwards (it copies `devices`).

### Do NOT

- Do NOT add a new wire field instead. That was considered and rejected: it leaves the raw uuid on the
  wire alongside the new field.
- Do NOT make the decoder strict in the same deploy as the migration.
- Do NOT run `db:pg:generate`. **0054 is assigned.**

**Depends on:** nothing hard. Runs beside PRs 18–21. Best after PR 13, so the panel's client has
already moved.

---

# PR 18 — Delete the expiring `/api/system*` shims

**Goal:** the stale-bundle compatibility shims from Phase 13 PR 4 go, both halves together.

### Inventory — three files, and the first two MUST go together

| Half                                           | Where                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next.config.js` rewrites                      | `next.config.js:36` (`/api/system/:path*` → `/api/device/:path*`), `:37` (`/api/systems/*` → `/api/devices/*`), `:39` (`/api/admin/systems/*`)     |
| `lib/route-matchers.ts` legacy shareable entry | `lib/route-matchers.ts:69` — `"/api/system/(.*)"`, under the comment block at `:61-68` that explicitly says "delete with the next.config rewrites" |
| the one-shot KV sweeper                        | `scripts/utils/kv-drop-legacy-integer-keys.ts` — 107 lines                                                                                         |

Each names the other in prose. Deleting the rewrite while leaving the matcher entry leaves a dangling
allow-list rule; deleting the matcher entry while leaving the rewrite would 404 anonymous shared
viewers on already-open tabs — which is exactly the failure the shim exists to prevent.

### 🛑 `?systemId=N` is a PERMANENT alias and does NOT go

`legacy_handles` resolves it forever (execution plan, "Keep permanently"). This PR deletes the **path**
rewrites (`/api/system/*` → `/api/device/*`), not the **query-param** alias. They are different things
and the naming makes them easy to conflate.

### Steps

1. Confirm the expiry has actually elapsed — the shim exists for the stale-browser-bundle window after
   the Phase 13 PR 4 deploy (2026-07-3x). Anyone with a tab open since then gets a 404 on the next
   fetch. State the elapsed time in the PR body.
2. Delete `next.config.js:36,37,39` and their comment block.
3. Delete `lib/route-matchers.ts:61-69`. Update `lib/__tests__/route-matchers.test.ts` — remove the
   `/api/system/*` shareable cases and **add a negative case** asserting the path is no longer
   shareable (a deletion with no test change is a deletion with no proof).
4. Confirm both environments have been swept, then delete `scripts/utils/kv-drop-legacy-integer-keys.ts`.
   ⚠️ A spent one-shot that still runs is worse than no tool.
5. `rm -rf .next-build` before `type-check`.

### Proof

- `curl` `/api/system/1/points` → 404 (expected); `/api/device/1/points` → 200.
- `?systemId=N` still resolves on `/api/data` and `/api/history` for every handle in `legacy_handles`.
- KV sweep confirmed on both environments before the script is deleted — paste the key counts.

### Do NOT

- Do NOT delete one half without the other.
- Do NOT touch `?systemId=`, `dashboards.legacy_id`, `legacy_handles`, slugs, or share-token strings.
  All permanent.

**Depends on:** nothing. Runs beside PRs 17, 19, 20, 21. Should follow PR 13 so it is not competing
for `lib/route-matchers.ts`.

---

# PR 19 — The `daily-stripe` card

**Goal:** the standalone HWS 7-day stripe becomes a generic v4 `daily-stripe` card.

Spec: [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md) §"Card A" (lines 75-108) and
§"Shared wiring" (60-74). Follow it; do not re-derive it.

### Steps (sketch — the plan doc is authoritative)

1. Add `"daily-stripe"` to `V4_CARD_TYPES` (`lib/dashboard/card-types.ts:18-39`) and a zod config
   schema in `CARD_CONFIG_SCHEMAS` (`:99-112`).
2. Add the `NODE_CATALOG` entry (PR 7's merged catalog) with its capability requirement.
3. Add the plugin module; register it in the single `CARD_RENDERERS`. The `satisfies Record<…>` turns a
   missing registration into a compile error — that is the wiring proof.
4. The card is a thin wrapper over `components/dashboard/DailyStripes.tsx` from PR 3.

### Proof

Per the plan's §Verification: place a `daily-stripe` card for `load.hws` on Kinkora into a v4 doc,
render it via the v4 path, confirm it reproduces the lab timeline; confirm the no-`state` variant is a
single-row-per-day gradient for a plain point; confirm graceful gaps and the domain fallback. Add unit
coverage for the new zod schema via the v4 validator.

### Do NOT

- Do NOT read `useSearchParams()` inside the card. Temporal window comes from the shared
  `useTemporalRange` (`lib/charts/useTemporalRange.ts:43`), threaded by the host.
- Do NOT add it to `app/labs/card-gallery/` — it needs a live `systemId` (the plan says so).

**Depends on:** PRs 3 and 7 (landed). Runs beside PR 20.

---

# PR 20 — The `heatmap` card

**Goal:** the selectable-series heatmap becomes a v4 `heatmap` card.

Spec: [hws-stripe-and-heatmap-cards.md](hws-stripe-and-heatmap-cards.md) §"Card B" (lines 109-135).

Same wiring shape as PR 19: card type + zod config (`series?`, `palette?`) + catalog entry + plugin,
wrapping `components/heatmap/HeatmapPanel.tsx` from PR 3.

### Proof

Per the plan: selector enumerates the area's points; the chart matches the standalone page; a pinned
`series`/`palette` hides the controls; **a stale pin falls back to the selector with a "pinned series
unavailable" note** (do not feed an unknown path to the chart); two heatmap cards on one dashboard do
not collide (card-local state, no URL writes); the slimmed standalone page still behaves identically.

### Do NOT

- Do NOT let the card write to the URL. The standalone page owns `useSearchParams`
  (`components/HeatmapClient.tsx:59`); the card must not.

**Depends on:** PRs 3 and 7 (landed). Runs beside PR 19.

---

# PR 21 — Signal-neutral run statistics (migration 0055)

**Goal:** `derived_intervals.{max,min,avg}_power_w` carry a unit in their name, so the
`detector_version` gate can be retired.

### The problem, restated from the execution plan's open follow-up

`derived-intervals-pg.ts` writes these as statistics of the **signal series, whatever it is** —
`lib/db/planetscale/derived-intervals-pg.ts:189-191` maps `p.maxW/minW/avgW` straight in.
`app/api/device/[systemId]/run-periods/route.ts:130-136` has to gate on `detector_version` because
prod's history is **mixed-unit and permanently so**: rows before the DSE re-point are Watts, rows after
are rpm. A dynamic header cannot fix it — **the columns must carry the unit rather than infer it.**

The sibling provenance columns already got this right and say so:
`lib/db/planetscale/schema.ts:822-826` — "Named for their units, deliberately not repeating the
`*_power_w` mislabelling they sit beside."

### Inventory

- Schema: `lib/db/planetscale/schema.ts:816,817,818`
- Writer: `lib/db/planetscale/derived-intervals-pg.ts:189-191`
- Reader + the gate: `app/api/device/[systemId]/run-periods/route.ts:130-136,165-170`
- Wire type: `lib/queries/runPeriods.ts:36`
- UI: `components/GeneratorClient.tsx:18-20,116,183-186,211`
- `avgPowerWFromEnergy` (`lib/run-tracking/run-period-view.ts:155`) is a **derived** value (energy ÷
  duration) and is genuinely Watts — **do not rename it.** Its test is
  `lib/run-tracking/__tests__/run-period-view.test.ts`.

### Steps

1. Decide the naming with Simon before writing DDL. The shape needs a value column plus a unit
   discriminator — e.g. `max_signal` / `min_signal` / `avg_signal` + `signal_unit text`, backfilled per
   row from `detector_version` (the existing gate encodes exactly that knowledge).
2. **Migration 0055**: add the new columns, backfill, assert with a `DO`/`RAISE EXCEPTION` that no row
   is left with a NULL unit, then drop the old columns — **or** split add/backfill from drop across two
   deploys if the reader cannot move in one step. Drops invert the ordering rule.
3. Retire the `detector_version` gate at `run-periods/route.ts:136`; the unit is now on the row.
4. ⚠️ **When a check becomes DB-enforced, replace it with the next unenforced invariant or delete it.**
   Do not leave a `detector_version` comparison that is now always true.

### Proof

- The generator-runs table on `/device/14` (the DSE genset) shows correct units for runs on **both**
  sides of the 11-Jul re-point. That mixed-unit boundary is the entire reason for the change.
- Row counts before/after the backfill, asserted inside the migration.
- `db:pg:generate` → _No schema changes_.

### Do NOT

- Do NOT rename `avgPowerWFromEnergy` or the `avgPowerW` **response** field where it is genuinely a
  derived Watt value.
- Do NOT infer the unit at render time from anything. That is the bug.
- Do NOT run `db:pg:generate` for a number. **0055 is assigned.**

**Depends on:** nothing. Runs beside PRs 17–20.

---

# PR 22 — Closeout

**Goal:** the epic's documentation ends in a state a stranger can read.

### 🛑 `docs/plans/config-v4-execution-plan.md` is KEPT

Simon's explicit instruction, 2026-07-31 — this **overrides** the plan's own "delete this file".
Rewrite it as the epic's **completed record**: the shipped table, the locked decisions, and the full
**Traps and rules** list (that section is the most valuable thing the epic produced and outlives it).
Strike the ▶ NEXT ACTION block and the "still v3" rows.

### Delete

- `docs/plans/config-v4-phase7-rehearsal-harness.md`
- `docs/plans/config-v4-phase8-cutover.md`
- `docs/plans/config-v4-phase14-prs.md` — **this file.** Git is the archive.
- `docs/plans/hws-stripe-and-heatmap-cards.md` — its two cards shipped in PRs 19–20.

### Fold survivors into `docs/architecture/data-model.md`

Anything still true about the v4 document model, the id seam, or the serving invariants belongs there,
not in a plans file. Per `docs/README.md`'s conventions: code is the source of truth for schema and
routes; docs hold only the _why_ and the invariants.

### Update `docs/README.md`

`:49` (the execution-plan line, currently "🔴 IN FLIGHT") and `:50` (the clean-sheet line) both need
rewriting. Remove the deleted files' index entries if any exist.

### Proof

- `npx prettier --check "docs/**/*.md"` passes.
- Every internal link in `docs/README.md` resolves (`grep -o '](\([^)]*\))' | while read` — check it).
- No surviving doc links to a deleted file.

### Do NOT

- Do NOT delete `config-v4-execution-plan.md`.
- Do NOT delete `config-v4-clean-sheet.md` — it is the canonical rationale and outlives the epic.

**Depends on:** everything. Last.
