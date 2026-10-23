-- 0081 — `dashboard_grants.role`: rename `viewer` → `view`, and add `control`.
--
-- ## Why
--
-- `control` is a new grant role: `view`, plus the right to command the devices the dashboard shows
-- that its OWNER owns (generator start/stop, EV charging) — see `controllableDeviceScopeForUser` in
-- lib/dashboard/grants.ts. `viewer` → `view` is a vocabulary change alongside it, so the roles read
-- as one set of verbs: view | control | admin. No row changes meaning.
--
-- ## 🛑 APPLY IMMEDIATELY BEFORE THE DEPLOY
--
-- Between this migration and the deploy, the running build still writes `'viewer'` on a grant
-- change — and the constraint below rejects it (23514 on `PUT /api/v4/dashboards/{id}/grants`).
-- Reads are unaffected: nothing in the old build branches on the role's value. Accepted for the
-- same reason as 0075 — a few minutes of one operator's own sharing surface.
--
-- ## 🛑 APPLY TO **BOTH** DATABASES, OR THE PROD→DEV SYNC STOPS
--
-- A CHECK definition that differs between prod and `liveone-dev` fails `assertManifestSchemaParity`
-- and the 2-hourly sync aborts wholesale. Prod: `npm run pg-migrate -- --apply`; dev:
-- `npm run db:pg:migrate`, in the same sitting.
--
-- Re-runnable: the UPDATE is a no-op the second time and both constraint statements are guarded.

ALTER TABLE "dashboard_grants" DROP CONSTRAINT IF EXISTS "dashboard_grants_role_check";

--> statement-breakpoint
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM dashboard_grants WHERE role = 'viewer';
  UPDATE dashboard_grants SET role = 'view' WHERE role = 'viewer';
  RAISE NOTICE 're-spelled % grant(s) from viewer to view', n;
END $$;

--> statement-breakpoint
-- GATE: nothing is left holding the retired spelling (a small config table; an exact count is free).
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM dashboard_grants WHERE role NOT IN ('view','control','admin');
  IF n > 0 THEN
    RAISE EXCEPTION 'GATE: % grant(s) hold a role outside view|control|admin after the rewrite', n;
  END IF;
END $$;

--> statement-breakpoint
-- `conrelid` is required: constraint names are unique per TABLE, so a bare `conname` lookup could be
-- satisfied by another table's constraint and silently skip the ADD (see 0075).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'dashboard_grants_role_check'
       AND conrelid = 'public.dashboard_grants'::regclass
  ) THEN
    ALTER TABLE "dashboard_grants"
      ADD CONSTRAINT "dashboard_grants_role_check"
      CHECK ("dashboard_grants"."role" IN ('view','control','admin'));
  END IF;
END $$;
