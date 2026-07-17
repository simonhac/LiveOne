# liveone — committed environment template (dev).
#
# Secrets are 1Password references into the liveone-dev vault — no values live
# in this file. Bootstrap a working .env.local with:
#
#   op inject -i .env.tpl -o .env.local
#
# (works with your personal op session, or OP_SERVICE_ACCOUNT_TOKEN scoped to
# liveone-dev). Prod secrets live in liveone-prod and are pushed to Vercel by
# the infra repo's sync tooling — never via this file.
#
# Managed by the infra repo (config/liveone.json). To add a var: classify it
# there first, sync the vault, then add the reference here.
#
# NOTE: op inject parses secret references ANYWHERE in this file, including
# comments — never write one here unless its field exists in the vault.

# ── app secrets (references into the liveone-dev vault's env item) ───────────
PLANETSCALE_DATABASE_URL="op://liveone-dev/env/PLANETSCALE_DATABASE_URL"
PLANETSCALE_DATABASE_URL_MIGRATIONS="op://liveone-dev/env/PLANETSCALE_DATABASE_URL_MIGRATIONS"
CLERK_SECRET_KEY="op://liveone-dev/env/CLERK_SECRET_KEY"
# KV is prod's store, shared BY DESIGN: dev reads it for fresh current values;
# dev never writes (no cron, no polling, no observation intake locally).
KV_REST_API_URL="op://liveone-dev/env/KV_REST_API_URL"
KV_REST_API_TOKEN="op://liveone-dev/env/KV_REST_API_TOKEN"
# QStash (publish + signature verification) is PROD-ONLY — dev runs no polling
# infrastructure. Those fields live solely in the liveone-prod vault.
OBSERVATIONS_ALERT_WEBHOOK_URL="op://liveone-dev/env/OBSERVATIONS_ALERT_WEBHOOK_URL"
OPEN_ELECTRICITY_API_KEY="op://liveone-dev/env/OPEN_ELECTRICITY_API_KEY"

# ── non-secret config (literals; public or identifiers) ──────────────────────
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_YXNzdXJpbmctZm9hbC01LmNsZXJrLmFjY291bnRzLmRldiQ
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_APP_URL=http://localhost:3000
PLANETSCALE_PROD_BRANCH_ID=91nbdvyn5o2z

# ── optional local knobs (uncomment as needed) ───────────────────────────────
# CRONS_ENABLED=false        # crons stay off locally (lib/cron/guard.ts)
# DB_SSL=disable             # only for a local non-SSL Postgres
# ALLOW_PROD_DB_IN_DEV=true  # dangerous: lets dev talk to the prod branch

# ── test/tool-only secrets (dev vault only; never in prod) ───────────────────
# CLERK_TESTING_TOKEN is deliberately absent: tests mint it on demand from
# CLERK_SECRET_KEY (lib/__tests__/test-auth-helper.ts).
TEST_AMBER_API_KEY="op://liveone-dev/env/TEST_AMBER_API_KEY"
TEST_AMBER_SITE_ID="op://liveone-dev/env/TEST_AMBER_SITE_ID"
TEST_BASE_URL="op://liveone-dev/env/TEST_BASE_URL"
TEST_USER_ID="op://liveone-dev/env/TEST_USER_ID"
