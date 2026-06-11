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

## Prerequisites (already set up once — only check if it breaks)

- DNS (Cloudflare): `preview.liveone.energy` CNAME → `cname.vercel-dns.com`, **DNS-only**.
- Vercel Preview env has the Clerk keys; repo is `vercel link`ed (`.vercel/project.json` present).

## ⚠️ Cautions to relay to the user

- **This preview reads PRODUCTION Postgres** (the `DB_*` env vars are shared across Production /
  Preview / Development). Treat it as **read-only** — dashboards, history, admin _read_ views.
  Do NOT poll-now, edit config, create/revoke tokens, or run crons from the preview.
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

Tell the user: open **https://preview.liveone.energy** (logged into Vercel to clear the 401),
sign in with the production Clerk user, and keep it read-only (it's pointed at prod data).

## Troubleshooting

- **Cert / domain error from Vercel on `alias set`:** the `preview.liveone.energy` CNAME may be
  missing or Cloudflare-proxied; it must be `cname.vercel-dns.com`, DNS-only (grey cloud).
- **Clerk still 500s in-browser:** the aliased build predates the Preview Clerk-secret env change —
  trigger a fresh deploy of the branch, then re-run this skill.
- **No deployment found:** the branch hasn't been pushed (no preview built yet), or its latest
  build isn't READY yet.
