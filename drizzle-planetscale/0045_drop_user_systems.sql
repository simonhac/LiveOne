-- 0045 config-v4 Phase 12 (slice F): drop the `user_systems` table.
--
-- WHAT DIES: `user_systems` — the pre-Areas per-system access grant — its `user_system_unique` +
-- 2 indexes, and its FK into `systems` (one of the four that must go before slice N can drop `systems`).
-- The clean-sheet retires it with NO REPLACEMENT (§4.8): per-person sharing is `dashboard_grants`
-- (invite) and `share_tokens` (public link), both scoped per-DASHBOARD. PROD HOLDS 0 ROWS (probed
-- 2026-07-28); `liveone-dev`'s ~22 are the grant-back debris that scripts/utils/reown-dev-data.ts
-- created, and the slice-F code PR deletes that writer.
--
-- WHAT THE CODE LOST, so the blast radius is on the record: the `isViewer` probe in lib/api-auth.ts
-- (`canRead` is now `isAdmin || isClaudeDev || isOwner || isPublic`; `canWrite` is BIT-IDENTICAL — this
-- grant never conveyed write); the granted legs of `listReadableDevices` and `assertMembersReadable`;
-- the `viewers` set on /api/admin/systems/{id}/admin-settings and the AdminTab UI section that drove it;
-- the whole (caller-less) /api/setup route; and the `user_systems` leg of the admin users list, so a
-- user who appeared ONLY via a grant no longer appears there. Because the probe sat behind
-- `!isOwner && !isAdmin` and only ever ORed into `canRead`, every one of those is provably
-- NARROWING-ONLY — no call site can gain access from this change.
--
-- One leg was re-pointed rather than deleted: `getSystemsVisibleByUser` now derives its granted systems
-- from `dashboard_grants` via `grantedSystemScopeForUser`. That is load-bearing for Vercel preview,
-- which authenticates against the LIVE prod Clerk instance while `liveone-dev`'s config has been reowned
-- to the dev id — without a granted leg the preview device switcher, the `/dashboard` landing redirect
-- and the area candidate list all go empty. The guard below encodes exactly that: it refuses to drop a
-- row whose access is NOT already carried by ownership or a dashboard grant.
--
-- WHY HAND-WRITTEN: drizzle-kit emits `DROP TABLE "user_systems" CASCADE` with no validation — the
-- migration-0016 failure mode (345K rows lost to an unvalidated drop), and 0037 is the local proof it
-- still bites. There is no replacement table to count rows against here, so the usual coverage
-- assertion is replaced by a REDUNDANCY assertion, plus a NOTICE that dumps the table's full contents:
-- it is <= ~22 rows and this is the only copy, so the apply log becomes the record.
--
-- Idempotent: a re-run finds the table absent and skips. IRREVERSIBLE (this project has no rollback
-- migrations — undo is a new forward migration); prod PITR + the 2-hourly R2 pg_dump cover recovery, and
-- prod is empty regardless. Preconditions: the slice-F code is merged and DEPLOYED first (this is a [D]
-- slice), then prod `sydney`, then `liveone-dev`. See the config-v4 epic record § Phase 12
-- slice F.

DO $$
DECLARE
  grant_rows bigint;
  contents   text;
  orphaned   text;
BEGIN
  IF to_regclass('public.user_systems') IS NULL THEN
    RAISE NOTICE 'user_systems already absent — nothing to validate';
    RETURN;
  END IF;

  -- 1. Preserve the contents in the apply log. Nothing else keeps a copy.
  SELECT count(*) INTO grant_rows FROM user_systems;
  SELECT string_agg(format('(%s, %s, %s)', clerk_user_id, system_id, role), ', ')
    INTO contents
    FROM user_systems;
  RAISE NOTICE 'user_systems holds % row(s): %', grant_rows, coalesce(contents, '(none)');

  -- 2. Refuse to drop a grant that is actually doing something. A row is redundant when the grantee
  --    either already OWNS that system (so ownership covers it) or holds at least one dashboard grant
  --    (so grantedSystemScopeForUser can reach it). Anything else is a read path about to vanish —
  --    which is exactly when this migration should stop and be looked at by a human.
  --
  --    ⚠️ The dashboard-grant half is deliberately LOOSE: it asks "does this user hold any dashboard
  --    grant at all", not "does a grant reach THIS system". The precise question needs
  --    `allowedSystemIds` — descriptor/doc parsing over dashboards + areas + area_bindings — which is
  --    application logic, not expressible here. So this is a necessary-not-sufficient screen: it
  --    reliably catches a grantee with no other read path whatsoever, and can pass a user whose grants
  --    happen not to cover the specific system. Given prod is empty and dev's rows are disposable
  --    reown-dev-data debris, that is the right trade; do not read it as a proof of equivalence.
  SELECT string_agg(format('(%s, %s)', us.clerk_user_id, us.system_id), ', ')
    INTO orphaned
    FROM user_systems us
   WHERE NOT EXISTS (
           SELECT 1 FROM systems s
            WHERE s.id = us.system_id
              AND s.owner_clerk_user_id = us.clerk_user_id
         )
     AND NOT EXISTS (
           SELECT 1 FROM dashboard_grants dg WHERE dg.user_id = us.clerk_user_id
         );
  IF orphaned IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop user_systems: grant(s) % are covered by neither ownership nor a dashboard grant, so dropping the table would REMOVE read access', orphaned;
  END IF;

  RAISE NOTICE 'checks ok: all % grant row(s) are redundant (covered by ownership or a dashboard grant)', grant_rows;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "user_systems";
