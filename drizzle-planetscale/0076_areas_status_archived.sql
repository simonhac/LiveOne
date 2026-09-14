-- 0076 — finish the job 0075 started: `areas.status` gets the same vocabulary, and a constraint.
--
-- ## What 0075 missed
--
-- 0075 renamed `devices.status` `'removed'` → `'archived'` on the premise that areas already spoke
-- `archived` and only devices spoke `removed`. That premise was half right. Verifying 0075 on prod
-- turned up an AREA still holding `'removed'` — `Craig (legacy)`, `ar_01kv06sxm3eez9t3dsqpbbmeh5`,
-- present on prod and on liveone-dev. So the split this work set out to remove existed INSIDE
-- `areas` as well as between the two tables.
--
-- ## Why it drifted, and why the constraint is the actual fix
--
-- 🛑 `areas.status` has never had a CHECK. Not a weakened one — none at all. `devices.status` has
-- had `devices_status_check` since its table was created, which is why devices only ever held three
-- values and why 0075 could be a simple rename. `areas.status` is a bare `text NOT NULL DEFAULT
-- 'active'`, so every value any writer ever passed is in there, and nothing would have said so.
--
-- Rewriting the one row without adding the constraint would fix today's data and leave the mechanism
-- that produced it fully intact. The constraint is the change; the UPDATE is just cleaning up after
-- the absence of one.
--
-- ## The vocabulary, and why it is two values and not three
--
-- `active | archived`. Deliberately NOT `devices`' three — there is no `disabled` for an area.
-- Measured against the code rather than guessed:
--   • the only writer of a literal is `createArea` (`lib/areas/create.ts`), which writes `'active'`;
--   • `PATCH /api/v4/areas/{id}` 422s anything that is not `'active'` or `'archived'`;
--   • `hardDeleteArea` (`lib/areas/delete.ts`) requires `'archived'` and deletes the row.
-- An area that is temporarily not to be served is archived, which is reversible. There is no state
-- between the two that anything can produce, so admitting one would be admitting a value with no
-- writer — the exact shape of the row this migration is cleaning up.
--
-- ## 🛑 APPLY TO **BOTH** DATABASES, for the same reason 0075 did
--
-- `assertManifestSchemaParity` (`lib/readings/prod-dev-sync.ts`) compares `pg_get_constraintdef` for
-- every table in the sync manifest before staging any data, and `areas` is in that manifest
-- (`prod-dev-sync.ts`, the `areas` leg). While prod has `areas_status_check` and liveone-dev does
-- not, that is a schema mismatch and the 2-hourly sync aborts WHOLESALE — not just the `areas` leg.
--
-- Unlike 0075 there is NO application window to worry about: no deployed code writes `'removed'` to
-- `areas.status`, so nothing can violate the new constraint between applying this and any deploy.
-- This migration is safe to apply at any time relative to a deploy.
--
-- Re-runnable: the UPDATE is a no-op the second time and the constraint statement is guarded.

--> statement-breakpoint
-- On the record: which rows, and how many. Not a gate — zero is a perfectly good answer on a
-- re-run, and one is the expected answer on a first run against prod or liveone-dev.
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM areas WHERE status = 'removed';
  UPDATE areas SET status = 'archived' WHERE status = 'removed';
  RAISE NOTICE 're-spelled % area(s) from removed to archived', n;
END $$;

--> statement-breakpoint
-- GATE: nothing is left outside the vocabulary the constraint is about to enforce.
--
-- 🛑 This is deliberately wider than `= 'removed'`. `areas.status` has never been constrained, so
-- "the values in there are the ones I know about" is exactly the assumption that produced this
-- migration. A third spelling nobody has thought of must abort HERE, with its name in the message,
-- rather than surface as a constraint violation naming only the constraint. `areas` is a small
-- config table, so an exact count costs nothing.
DO $$ DECLARE bad text; BEGIN
  SELECT string_agg(DISTINCT status, ', ') INTO bad
    FROM areas WHERE status NOT IN ('active', 'archived');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'GATE: areas.status holds unexpected value(s): %. Decide what each one means before constraining the column — adding the constraint would fail naming only `areas_status_check`.', bad;
  END IF;
END $$;

--> statement-breakpoint
-- The constraint the column should always have had. Named to match `devices_status_check`.
--
-- 🛑 `conrelid` scopes the guard. Constraint names are unique per TABLE, not per database, so a bare
-- `conname` lookup can be satisfied by an identically-named constraint elsewhere — and this block
-- would then silently skip the ADD and report success on an unconstrained column, which is the
-- precise failure this migration exists to correct.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'areas_status_check'
       AND conrelid = 'public.areas'::regclass
  ) THEN
    ALTER TABLE "areas"
      ADD CONSTRAINT "areas_status_check"
      CHECK ("status" IN ('active','archived'));
  END IF;
END $$;
