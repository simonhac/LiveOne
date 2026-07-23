---
name: bind-preview
description: >-
  Set up and safeguard Vercel preview deploys on *.preview.liveone.energy. Per-branch
  preview URLs are now created AUTOMATICALLY on push by the preview-alias CI workflow —
  use this skill for the things CI does NOT do: standing up an isolated, seeded preview
  DB branch, enforcing the "never preview against production" policy, manually aliasing a
  specific/older deployment as a fallback, or troubleshooting a preview that 401s / shows
  a stale build / errors on Clerk.
---

# Preview deploys on `*.preview.liveone.energy`

## ✅ Per-branch preview URLs are now automatic (you usually don't need to alias by hand)

On every push to a non-`main` branch, the CI workflow
[`.github/workflows/preview-alias.yml`](../../../.github/workflows/preview-alias.yml) finds the
Vercel preview deployment built for that exact commit, waits until it's READY, and binds a stable
alias **`<sanitized-branch>.preview.liveone.energy`** to it (e.g.
`simonhac/preview-subdomain-ci` → `https://simonhac-preview-subdomain-ci.preview.liveone.energy`).
Deleting the branch removes the alias. Because it's a subdomain of `liveone.energy`, the production
Clerk session carries over — no login prompt.

So to open a branch's preview: push it, wait for the `Preview alias` Action to go green, then open
`https://<sanitized-branch>.preview.liveone.energy`. The label is: lowercase, `/`→`-`, non
`[a-z0-9-]` stripped, `≤63` chars (a short hash is appended on truncation). This skill is now mainly
about the **preview DB** (below) and the **manual fallback** (bottom).

## Why this exists (still true)

Production Clerk keys (`pk_live_`/`sk_live_`) only authorise `liveone.energy` and its subdomains, so
Clerk **fails on the default `*.vercel.app` preview URLs**
(`MIDDLEWARE_INVOCATION_FAILED` / "Production Keys are only allowed for domain liveone.energy").
Vercel's native "Preview Deployment Suffix" would automate a subdomain but is a paid add-on that
needs the domain on Vercel nameservers; our DNS is on Cloudflare. So CI does the DIY equivalent
(`vercel alias` under a wildcard) for free. A Vercel **alias is pinned to one deployment** and does
not follow new pushes — the CI job re-points it per commit; the manual fallback below does it by hand.

## 🚫 Policy: NEVER preview against production

**The preview must always read an isolated, non-prod DB — never production Postgres. No exceptions,
not even for "UX-only" or "read-only" changes, and not even when you're the only user.**

The failure mode is silent: the `DB_*` env vars are shared across Production / Preview / Development,
so if the Preview env has **no** `PLANETSCALE_DATABASE_URL` override, the runtime falls back to those
shared vars and every preview quietly points at **prod**. So the Preview env's
`PLANETSCALE_DATABASE_URL` must **always** be set to a non-prod branch — and it applies to **all**
preview deployments at once (a single Preview-scoped value; Vercel env vars aren't per-deployment).

Two things keep this safe, and both are **Preview-scope prerequisites**, not something CI sets:

1. `PLANETSCALE_DATABASE_URL` (Preview scope) → a non-prod branch. Today this is the shared
   **`liveone-dev`** database; with many concurrent auto-previews, also set **`PLANETSCALE_POOL_MAX=3`**
   (Preview scope) so they don't exhaust liveone-dev's small connection budget. A per-branch isolated
   DB is a deferred upgrade — the seeded-branch recipe below is the reference for it.
2. `PLANETSCALE_PROD_BRANCH_ID` (all scopes, incl. Preview) arms the runtime guard
   `assertDbEnvironmentMatches` (`lib/db/planetscale/index.ts`), which **throws** in dev/preview if the
   resolved connection identity is the prod (`sydney`) branch. This is the backstop if (1) is ever unset.

**Guard — confirm Preview has a non-prod DB override (run once when setting up / after env changes):**

```bash
vercel env pull /tmp/preview.env --environment=preview --yes >/dev/null 2>&1
PREVIEW_DB="$(grep '^PLANETSCALE_DATABASE_URL=' /tmp/preview.env | cut -d= -f2- | tr -d '"')"
grep -E '^(PLANETSCALE_PROD_BRANCH_ID|PLANETSCALE_POOL_MAX)=' /tmp/preview.env
rm -f /tmp/preview.env
if [ -z "$PREVIEW_DB" ]; then
  echo "🚫 Preview has no PLANETSCALE_DATABASE_URL → it falls back to the shared DB_* = PROD."
  echo "   Point Preview at liveone-dev (or a seeded throwaway branch) first. Aborting."; exit 1
fi
# The username segment encodes the branch (e.g. postgres.<branchid>). Confirm it is NOT the
# sydney/prod branch — prod is the standalone `sydney` branch.
echo "Preview DB user: $(printf '%s' "$PREVIEW_DB" | sed -E 's#^[^/]*//([^:]+):.*#\1#')"
echo "   → verify this is liveone-dev / a throwaway branch, NOT sydney/prod."
```

## Prerequisites (set up once — only check if it breaks)

- **DNS (Cloudflare):** wildcard `*.preview.liveone.energy` CNAME → `cname.vercel-dns.com`,
  **DNS-only** (grey cloud, not proxied). This is what makes every `<label>.preview.liveone.energy`
  resolve to Vercel; Vercel issues a per-host cert via HTTP-01 on first alias assignment.
- **Vercel:** `*.preview.liveone.energy` is added as a project domain (so aliases under it are
  accepted). Preview env has the Clerk keys.
- **CI (repo settings):** secret `VERCEL_TOKEN` (team-scoped, read deployments + create/delete
  aliases) and variables `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`. Consumed by `preview-alias.yml`.

## ⚠️ Cautions to relay to the user

- **Every preview reads a non-prod DB** (see the Policy). Speed/convenience is never a reason to point
  preview at prod — if a DB is cold/slow, warm it or accept the latency, don't fall back to prod.
- Sign in with your **production** Clerk user (live instance). The dev/test Clerk instance has
  different user IDs that won't match prod data.
- The deployment must have been built **after** `CLERK_SECRET_KEY` was added to the Preview env;
  if Clerk still errors, redeploy the branch (push again → CI re-aliases), or use the fallback below.

## Isolated, seeded preview DB branch (the per-branch-isolation upgrade — reference)

The current model shares one `liveone-dev` DB across all previews. For **isolated per-branch data**
(safe concurrent writes, no 2-hourly sync clobber), give a branch its own seeded PlanetScale branch.
**PlanetScale Postgres has no copy-on-write data branches** — a fresh branch is schema-only
(https://planetscale.com/docs/postgres/branching), so it must be seeded.

**1. Create the branch.** Either a full data copy from a backup (slower, own storage), or an empty
branch you seed with a recent slice (cheaper/faster):

```bash
# Full data (all rows) — pick a small cluster to keep it cheap; verify the SKU (a branch off a
# production branch may bill as production):
pscale backup list liveone sydney                                  # find a recent backup id
pscale branch create liveone <branch> --restore <BACKUP_ID> --cluster-size PS-5 --wait
#   …or an empty branch + seed scripts (what the steps below assume):
pscale branch create liveone <branch> --from sydney --wait
```

`--seed-data` does NOT copy data for Postgres (it's a MySQL/Vitess feature) — don't rely on it.

**2. Point the Preview env at it** (Preview-scoped only — Production keeps its prod `DB_*`):

```bash
pscale role reset-default liveone <branch> --format json   # postgres creds for the branch (rotates them)
# Runtime reads PLANETSCALE_DATABASE_URL first; use ?sslmode=no-verify so node-pg's TLS works:
printf '%s' "<branch_database_url>?sslmode=no-verify" | vercel env add PLANETSCALE_DATABASE_URL preview
# optional feature flags, Preview-only:
printf 'true' | vercel env add DECLARATIVE_DASHBOARD preview
printf 'true' | vercel env add DASHBOARD_PERSISTENCE preview
```

**3. Seed it** (only for an empty branch). Two scripts in `scripts/`:

```bash
SRC=$(grep '^PLANETSCALE_DATABASE_URL_MIGRATIONS=' .env.local | cut -d= -f2- | tr -d '"')
vercel env pull /tmp/preview.env --environment=preview --yes
DST=$(grep '^PLANETSCALE_DATABASE_URL=' /tmp/preview.env | cut -d= -f2- | tr -d '"')

# All config + 10d raw/5m readings + sessions + 45d daily aggregates (~4 min; tune with
# SEED_DAYS / SEED_DAYS_DAILY). Idempotent: re-runs refresh the slice, keep config + dashboards.
SOURCE_DATABASE_URL="$SRC" TARGET_DATABASE_URL="$DST" npx tsx scripts/seed-preview-db.ts

# Live-style power cards: rebuild the dev: KV namespace (which preview reads, since
# VERCEL_ENV=preview -> getEnvironment()="dev") from the seeded branch DB. No prod KV creds. ~10s.
# (Inline PLANETSCALE_DATABASE_URL=$DST overrides the .env.local value; KV creds come from .env.local.)
PLANETSCALE_DATABASE_URL="$DST" npx tsx --env-file=.env.local scripts/utils/rebuild-dev-kv-from-db.ts

rm -f /tmp/preview.env
```

**4. Redeploy so the build picks up the Preview env** (`git push`, or `vercel deploy`). CI then
aliases `<branch>.preview.liveone.energy` to it. Charts read the 5m/1d aggregates; power cards read
the KV snapshot. **Tear down when done:** `pscale branch delete liveone <branch>` (stops cluster
billing) and remove the Preview-only env vars.

## Manual alias fallback (rare)

CI aliases each push automatically; only alias by hand to point at a **specific/older** deployment,
or when the CI job is unavailable. Run from the repo (needs a local `vercel login` + `.vercel`):

```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
branch="$(git rev-parse --abbrev-ref HEAD)"
# Reproduce the CI label so you hit the same subdomain:
label="$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]' | tr '/' '-' \
          | sed -E 's/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-+//; s/-+$//' | cut -c1-63 | sed -E 's/-+$//')"
DOMAIN="${label}.preview.liveone.energy"
ORG="$(node -e 'console.log(require("./.vercel/project.json").orgId)')"
PRJ="$(node -e 'console.log(require("./.vercel/project.json").projectId)')"
TOKEN="$(node -e 'console.log(require(process.env.HOME+"/Library/Application Support/com.vercel.cli/auth.json").token)')"
URL="$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v6/deployments?projectId=$PRJ&teamId=$ORG&target=preview&limit=50" \
  | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s), b=process.argv[1];
      const ds=(j.deployments||[]).filter(d=>d.state==="READY" && d.meta && d.meta.githubCommitRef===b)
        .sort((a,c)=>c.created-a.created);
      if(ds[0]) console.log("https://"+ds[0].url);
    })' "$branch")"
[ -n "$URL" ] || { echo "No READY preview for '$branch' — push it (or vercel deploy) first."; exit 1; }
echo "Branch '$branch' -> $URL"
vercel alias set "$URL" "$DOMAIN"
```

## Troubleshooting

- **CI `alias set` fails with a domain/cert error:** `*.preview.liveone.energy` isn't added as a
  Vercel project domain, or the wildcard CNAME is missing / Cloudflare-proxied — it must be
  `cname.vercel-dns.com`, DNS-only (grey cloud). First HTTPS hit after a fresh alias may briefly
  5xx while the per-host cert issues.
- **Clerk still 500s in-browser:** the aliased build predates the Preview Clerk-secret env change —
  push again (CI re-aliases the new build), or use the fallback.
- **No deployment found / alias points at an old build:** the branch push hasn't produced a READY
  preview yet — wait for the Vercel build, then the `Preview alias` Action.
- **Preview shows prod-looking data or the app 500s on boot:** the DB guard tripped or Preview lost
  its `PLANETSCALE_DATABASE_URL` override — re-run the guard above.
