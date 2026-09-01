# The operator CLI (`liveone`)

> **Status: current** — describes the CLI as of the device/area/user domains landing. The
> generated reference ([cli-reference.md](cli-reference.md), `scripts/ops/CLI_README.md`,
> [cli-tools.json](cli-tools.json)) is the inventory; this doc holds the why and the invariants.

## One command, domain groups

`npm run liveone -- <domain> <verb>` (`scripts/ops/liveone.ts`) is the single entrypoint. Domains
(`auth`, `dashboard`, `device`, `area`, `user`, plus the root-level `find` verb) are **composable
modules** — each exports a `defineCommand()` spec and a dispatcher, and deliberately owns no
entrypoint, because a module with one cannot be imported without running it. One command means one
credential, one `--help` tree, one searchable catalogue — and one surface a future MCP server
renders its tool list from (`lib/cli/tool-schema.ts` already emits Anthropic-shaped tool schemas;
`docs/cli-tools.json` is that rendering, committed).

## The kit's contracts (`lib/cli/cli.ts`)

Every command gets these for free, and every handler is held to them:

- **Stdout purity.** Data on stdout, diagnostics on stderr. `ctx.emit(model, humanRenderer)` is
  the only path to stdout: one model, two serialisers (`--format human|json`), so the two renderings
  cannot drift into reporting different things. Human is the default at a terminal, json when piped.
- **The exit vocabulary.** `0` ok · `1` findings (ran fine, negative/empty answer) · `2` usage
  (nothing attempted) · `3` auth · `5` upstream · `130` interrupted. A refusal that is *about the
  caller's request* is a finding, not an upstream failure.
- **Arity-aware parsing.** Unknown flags and subcommands are refused with a did-you-mean; a value
  that looks like a flag is a *missing value* error. `ctx.flags` is keyed by the **declaration key**
  (camelCase), not the kebab form the caller typed — read `str(ctx, "configJson")`, never
  `"config-json"` (the latter silently returns undefined; it has shipped a dropped flag before).
- **Dry-by-default writes.** `mutates: true` on a subcommand adds `--apply`/`--dry-run`/`--yes` and
  flips the default to dry. Off a terminal, `--apply` additionally requires `--yes`, because a
  prompt with no terminal is a hang. Declaring `mutates` does not honour it — handlers branch on
  `ctx.dryRun`.
- **Spec fields that matter.** `when` is trigger conditions ("reach for this when…") and is the
  highest-weighted field in `liveone find`'s index; `description` is how to read the answer and
  what the traps are; `uses: ["db"|"api"|"clerk"]` declares reach and derives the documented exit
  codes.

## Transports and auth

**Http is the default and the well-guarded path.** `liveone auth login` mints a `lo_cli_` token via
a browser hand-off, stored per-origin in `~/.config/liveone/cli-auth.json` (0600, no cross-origin
fallback). Origin resolution (`lib/cli-kit/target.ts`) is one implementation on purpose:
`--base-url` > `LIVEONE_BASE_URL` > the store's remembered default > prod (www, never the apex —
undici strips `Authorization` on cross-origin redirects, so `apiFetch` refuses redirects rather
than following them). Every command prints `target: <origin> as <you> · clerk … · db … · build …`
on stderr before any work — **read it**; there is deliberately no "am I on prod" auto-detection,
because a false reassurance is worse than none. The printed identity is the check.

**The db transport exists only on `dashboard`.** Its one irreplaceable case: repairing a doc whose
refs the owner cannot read (the repairing PUT would itself be 403'd). The read-only domains
(`device`, `area`, `user`) are http-only by design — their data lives behind the KV latest cache,
the history aggregation and the flow-matrix fold, so a db leg would re-implement all three to be
equally right. They share `lib/cli-kit/api-session.ts` (origin + token + the same target line)
instead of a transport seam.

**The edge story.** Clerk's `auth.protect()` rewrites unauthenticated `/api` requests to a 404
before any handler runs, so a credential only the handler understands never gets the chance to be
understood. `cliTokenRoutes` (`lib/route-matchers.ts`) bounds a **presence-only** bypass for
requests carrying an `lo_cli_` bearer — it never validates anything at the edge; the handler's own
`requireAuth`/`requireAdmin`/`requireDashboardAccess`/`loadOwnedDashboard` is the single
enforcement point (`getAuthContext` resolves the token and yields `userId: null` for anything
invalid). The invariant "every route under the bypass authorizes in-handler" is enforced
structurally by `lib/__tests__/cli-token-edge.test.ts`; widening the matcher without satisfying
that test is how a bypass becomes a hole. The matcher is surgical on purpose: the areas aggregate
GET is listed as `:id`, not `(.*)`, so `members`/`bindings` stay outside until a verb needs them,
and the admin tree and point-control routes are outside entirely.

The `derivations` sub-tree is the worked example of "until a verb needs them". `liveone derivation`
needed four of them, so four named segments were admitted — the resource, the member (PATCH), and
its `recompute`/`intervals` sub-resources — each authorizing through `loadDerivationForOwner`, which
calls `loadAreaForOwner` and then puts the AREA in its WHERE clause. The interesting one is
`recompute`: it is a delete-and-reinsert over history, and it was admitted only because **its scope
is a path segment**. Its cron twin, `/api/cron/derivations`, takes the same actions with an
*optional* filter and therefore has an unscoped form; it stays outside the bypass, and
`cli-token-edge.test.ts` asserts that it does. That is the rule the sub-tree illustrates — the
question is never "is this route related to one we already trust", it is "what is the worst call
this address can spell".

## The generated reference

`lib/cli/tiers.ts` is the registry — a file is tier `a` (full conformance, documented), `b`
(harness + exit codes), `c` (composable module / exempt), or unlisted, and **unlisted is a
finding** (`npm run check:cli`), because a checker that builds its target list from its own
manifest goes blind to exactly the files that skipped it. From the tier-a/b specs,
`npm run cli:reference -- --apply` regenerates three committed artifacts: `scripts/ops/CLI_README.md`
(full `--help` per node), `docs/cli-reference.md` (index), `docs/cli-tools.json` (the MCP-shaped
catalogue). `lib/cli/__tests__/registry.test.ts` fails the suite when they are stale, so a new verb
cannot merge undocumented. `liveone find <query>` searches the committed catalogue offline — it
imports no tools.

## Adding a domain (the checklist)

1. `scripts/ops/<domain>/cli.ts`: export `<domain>Command = defineCommand({…} satisfies
   CommandSpec)` + `run<Domain>(ctx)`. No `run()` call. Shared pieces (flag groups, ref
   resolution, the history verb) live in `scripts/ops/shared.ts`.
2. Mount it in `scripts/ops/liveone.ts` (`subcommands` + `DOMAINS`).
3. Register the file(s) in tier `c` of `lib/cli/tiers.ts`.
4. New API surface? Add the route, put its pattern in `cliTokenRoutes`, and satisfy
   `cli-token-edge.test.ts` (the handler must carry one of the authorizing helpers). Remember the
   deploy-order coupling: the CLI 404s (diagnosed as protect-rewrite) against builds that predate
   the matcher change.
5. `npm run check:cli` → zero new findings; `npm run cli:reference -- --apply`; `npm test`.
6. Update the domain list in `CLAUDE.md`.

## Troubleshooting (each entry earned in the field)

- **401 vs 404 tells you which layer refused you.** A 401 whose response carries
  `x-clerk-auth-reason: token-invalid` means the request reached the server and the **credential**
  was rejected — CLI tokens live hashed in Clerk and can be revoked/rotated server-side regardless
  of the local store's `expiresAt`, so a token that "looks valid" locally can still be dead; re-run
  `liveone auth login`. A 404 diagnosed as `protect-rewrite` means the **edge** rewrote the request
  before any handler ran — the route isn't deployed yet, or isn't in `cliTokenRoutes`. Deploy
  first; the http layer's error messages name which case you're in.
- **`--series` globs match the device-less path.** Patterns are matched against the path *after*
  the device prefix (`load/energy.delta`, not `1000002/load/energy.delta`), and `*` does not cross
  `/` — so `load/*` matches, `*/load/*` doesn't. A glob that matches nothing is an error, not an
  empty success.
- **Capabilities vs adapter state.** Capabilities are *derived* (point scan + compound predicates):
  `device show` carries them via `?include=capabilities`, and `area show`'s members carry the same
  list in context — the area aggregate is authoritative. `adapterState` (vendor-reported metadata)
  is on `device show` only, and is often `null`.
- **History windows are LOCAL fixed-offset days.** `--start/--end` bound whole days at the
  subject's `dayOffsetMin` — the same boundaries the daily aggregates roll up on. Deliberately not
  DST-aware.
- **Piping is safe.** npm's run-script banner goes to stderr, so
  `npm run liveone -- … --format json | jq` yields clean JSON; `--silent` merely tidies stderr.

## Deferred candidates (and why)

- **Write verbs** for device/area (config patch, rename, members) — same `mutates` machinery as
  `dashboard`; add when there is a real operation to gate.
- **`point` domain** including control preflight/action — widening the edge bypass onto
  `/api/v4/points/*` is a control-plane security decision, deferred deliberately.
- **`device poll-status`** — needs a v4 read over `device_state`.
- **Session / raw-vendor-payload lookup** — `sessions.response` is the first stop for "does the
  vendor actually send X?", but it is a large admin-shaped surface; decide transport when needed.
- **`area recompute-provenance`** — the first mutating area verb, when needed.
- **`area devices`** — inline each member's full device aggregate (the per-device-config question
  currently takes `area show` + N × `device show`).
- **`auth list --verify`** — ping whoami per stored origin, so a server-side-revoked token
  surfaces before it surprises a command.
