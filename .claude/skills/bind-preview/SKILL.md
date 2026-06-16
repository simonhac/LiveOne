---
name: bind-preview
description: >-
  Point preview.liveone.energy at the current git branch's latest Vercel preview
  deployment, so the preview works with production Clerk auth (Clerk's live keys are
  domain-locked to liveone.energy and reject *.vercel.app URLs). Use after pushing a
  branch when you want to open its preview deploy in the browser, or whenever
  preview.liveone.energy is showing a stale/old deployment.
---

# Bind preview.liveone.energy to the current branch's preview

## Why this exists

Production Clerk keys (`pk_live_`/`sk_live_`) only authorise the `liveone.energy` domain and
its subdomains, so Clerk **fails on the default `*.vercel.app` preview URLs**
(`MIDDLEWARE_INVOCATION_FAILED` / "Production Keys are only allowed for domain liveone.energy").
A wildcard "Preview Deployment Suffix" would automate this but is a paid Pro add-on; instead we
keep one stable subdomain, **`preview.liveone.energy`**, and re-point it at whichever preview
deployment we want to test. This skill does that re-pointing.

A Vercel **alias is pinned to one deployment** — it does NOT follow new pushes. Re-run this skill
after each push (or when switching branches) to move `preview.liveone.energy` to the newest build.

## 🚫 Policy: NEVER preview against production

**The preview must always read an isolated, seeded DB branch — never production Postgres. No
exceptions, not even for "UX-only" or "read-only" changes, and not even when you're the only user.**

The failure mode is silent: the `DB_*` env vars are shared across Production / Preview / Development,
so if the Preview env has **no** `PLANETSCALE_DATABASE_URL` override, the runtime falls back to those
shared vars and the preview quietly points at **prod**. Therefore the Preview env's
`PLANETSCALE_DATABASE_URL` must **always** be set to a non-prod branch (see "Isolated, seeded preview
DB branch" below) before you alias anything.

**Guard — run before aliasing; abort if Preview has no DB override (→ would read prod):**

```bash
vercel env pull /tmp/preview.env --environment=preview --yes >/dev/null 2>&1
PREVIEW_DB="$(grep '^PLANETSCALE_DATABASE_URL=' /tmp/preview.env | cut -d= -f2- | tr -d '"')"
rm -f /tmp/preview.env
if [ -z "$PREVIEW_DB" ]; then
  echo "🚫 Preview has no PLANETSCALE_DATABASE_URL → it falls back to the shared DB_* = PROD."
  echo "   Point Preview at a seeded throwaway branch first (see below). Aborting."; exit 1
fi
# The username segment encodes the branch (e.g. postgres.<branchid>). Confirm it is NOT the
# sydney/prod branch before continuing — prod is the standalone `sydney` branch.
echo "Preview DB user: $(printf '%s' "$PREVIEW_DB" | sed -E 's#^[^/]*//([^:]+):.*#\1#')"
echo "   → verify this is a throwaway branch, NOT sydney/prod, before aliasing."
```

## Prerequisites (already set up once — only check if it breaks)

- DNS (Cloudflare): `preview.liveone.energy` CNAME → `cname.vercel-dns.com`, **DNS-only**.
- Vercel Preview env has the Clerk keys; repo is `vercel link`ed (`.vercel/project.json` present).

## ⚠️ Cautions to relay to the user

- **The Preview env MUST point at an isolated, seeded DB branch — never prod** (see the Policy
  above). Set up the branch first (see "Isolated, seeded preview DB branch"), run the guard, and only
  then alias. Speed/convenience is never a reason to point preview at prod — if a throwaway branch is
  cold/slow, warm it or accept the latency, don't fall back to prod.
- Sign in with your **production** Clerk user (live instance). The dev/test Clerk instance has
  different user IDs that won't match prod data.
- The deployment must have been built **after** `CLERK_SECRET_KEY` was added to the Preview env;
  if Clerk still errors, redeploy the branch first, then re-run this skill.

## Steps

Run this from the repo. It finds the newest **READY** preview deployment whose git branch matches
the current checkout, aliases `preview.liveone.energy` to it, and verifies.

```bash
set -euo pipefail
DOMAIN="preview.liveone.energy"
cd "$(git rev-parse --show-toplevel)"
branch="$(git rev-parse --abbrev-ref HEAD)"

ORG="$(node -e 'console.log(require("./.vercel/project.json").orgId)')"
PRJ="$(node -e 'console.log(require("./.vercel/project.json").projectId)')"
TOKEN="$(node -e 'console.log(require(process.env.HOME+"/Library/Application Support/com.vercel.cli/auth.json").token)')"

URL="$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v6/deployments?projectId=$PRJ&teamId=$ORG&target=preview&limit=50" \
  | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s), b=process.argv[1];
      const ds=(j.deployments||[])
        .filter(d=>d.state==="READY" && d.meta && d.meta.githubCommitRef===b)
        .sort((a,c)=>c.created-a.created);
      if(ds[0]) console.log("https://"+ds[0].url);
    })' "$branch")"

if [ -z "$URL" ]; then
  echo "No READY preview deployment found for branch '$branch'."
  echo "Push the branch (Vercel auto-builds a preview) and retry, or run: vercel deploy"
  exit 1
fi

echo "Branch '$branch' -> $URL"
vercel alias set "$URL" "$DOMAIN"
curl -sS -o /dev/null -w "https://$DOMAIN -> HTTP %{http_code} (401 = Vercel deploy-protection gate, expected; open it in a browser logged into Vercel)\n" "https://$DOMAIN/"
```

## After running

Tell the user: open **https://preview.liveone.energy** (logged into Vercel to clear the 401) and
sign in with the production Clerk user. The preview is backed by an isolated seeded branch, so it's
safe to exercise writes (save dashboards, edit config) without touching prod.

## Isolated, seeded preview DB branch (REQUIRED — always)

This is **mandatory for every preview** (see the Policy above), not just schema/data work — it's how
the preview avoids prod. **PlanetScale Postgres has no copy-on-write data branches** — a fresh branch
is schema-only (https://planetscale.com/docs/postgres/branching), so it must be seeded. Reuse an
existing seeded throwaway branch if one is already up; otherwise create one.

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

**4. Redeploy + alias.** `vercel deploy` (so the build picks up the Preview env), then run the alias
step above against the new deployment. Charts read the 5m/1d aggregates; power cards read the KV
snapshot. **Tear down when done:** `pscale branch delete liveone <branch>` (stops cluster billing)
and remove the Preview-only env vars.

## Troubleshooting

- **Cert / domain error from Vercel on `alias set`:** the `preview.liveone.energy` CNAME may be
  missing or Cloudflare-proxied; it must be `cname.vercel-dns.com`, DNS-only (grey cloud).
- **Clerk still 500s in-browser:** the aliased build predates the Preview Clerk-secret env change —
  trigger a fresh deploy of the branch, then re-run this skill.
- **No deployment found:** the branch hasn't been pushed (no preview built yet), or its latest
  build isn't READY yet.
