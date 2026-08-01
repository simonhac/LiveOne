-- 0048 config-v4 Phase 12 (slice E PR 2b): `area_bindings` drops the legacy `(point_system_id,
-- point_id)` pair.
--
-- WHAT DIES: the two integer columns that used to be a binding's address. 0047 already took away
-- everything structural — the composite FK into `point_info`, `area_bindings_unique`, and
-- `area_bindings_point_idx` all moved to `point_uid` — and relaxed both columns to NULLable so the
-- writers could stop naming them. PR 2b is where the last two consumers actually stopped: the
-- area-builder wire now speaks `pt_` TypeIDs end to end (`/api/areas`, `PUT .../bindings`,
-- `BindingsTab`), and the KV subscription map's SOURCE key is now the point's uuid rather than its
-- integer index. So at the moment this runs, nothing in the tree names either column — which is
-- exactly the state check 2 below refuses to take on trust.
--
-- WHY THE PAIR IS SAFE TO DESTROY: `point_uid` is the same address wearing a uuid, and 0047 asserted
-- that equivalence row by row. Check 3 asserts it AGAIN here, deliberately: this is the LAST moment
-- the cross-check is physically possible. After the DROP there is no second address to disagree with,
-- so a divergence introduced between 0047 and now (a hand-edited row, a botched restore, a sync that
-- wrote one column and not the other) would become silent and permanent — an Area serving another
-- device's point with nothing left to detect it. A check that can only ever run once should run.
--
-- WHY HAND-WRITTEN: drizzle-kit emits the two `DROP COLUMN`s below with no preconditions whatsoever.
-- A `DROP COLUMN` is irreversible and, unlike 0047's re-basing, destroys DATA rather than metadata:
-- if 0047 had not in fact landed on this branch, drizzle would happily drop the only working address
-- and leave the table addressable by nothing. That is the migration-0016 failure mode. So: prove 0047
-- landed, prove nothing else depends on the columns, re-prove the equivalence, and only then contract.
-- `meta/0048_snapshot.json` and the journal entry stay machine-written so a future `db:pg:generate`
-- still diffs clean.
--
-- NOTE the guard's RAISE NOTICEs are SWALLOWED under `npm run db:pg:migrate` (drizzle-orm's migrator
-- attaches no 'notice' listener — the slice-G lesson). Capture the row inventory by hand before
-- applying if you want it on the record.
--
-- Idempotent: a re-run finds `point_system_id` already gone and skips every check; both statements
-- below are `DROP COLUMN IF EXISTS`. IRREVERSIBLE (this project has no rollback migrations — undo is
-- a new forward migration); prod PITR + the 2-hourly R2 pg_dump cover recovery, and — unlike 0047 —
-- the dropped values are NOT reconstructible from the surviving schema alone, only from a backup.
--
-- ⚠️ REQUIRED POST-DEPLOY STEP, and it is NOT part of this migration: the persisted KV subscription
-- registry (`subscriptions:system:N`) is keyed by the SOURCE POINT, and PR 2b changed that key from
-- the integer index to the uuid. Entries written before the deploy will never match a uuid lookup, so
-- multi-device areas serve no fresh values until `buildSubscriptionRegistry()` is re-run on prod AND
-- `liveone-dev` (`npx tsx scripts/build-subscription-registry.ts`).
--
-- Preconditions: the slice-E PR 2b code is merged and DEPLOYED first (every writer must already have
-- stopped naming the pair), then prod `sydney`, then `liveone-dev`. See
-- the config-v4 epic record § Phase 12 slice E.

DO $$
DECLARE
  total_rows  bigint;
  unique_def  text;
  dependents  text;
  disagreeing text;
BEGIN
  IF NOT EXISTS (SELECT 1
                   FROM pg_attribute
                  WHERE attrelid = 'public.area_bindings'::regclass
                    AND attname  = 'point_system_id'
                    AND NOT attisdropped) THEN
    RAISE NOTICE 'area_bindings.point_system_id already gone — 0048 already applied, skipping checks';
    RETURN;
  END IF;

  SELECT count(*) INTO total_rows FROM area_bindings;

  -- 1. 0047 must have landed. Its observable signature is `area_bindings_unique` keying on
  --    `point_uid`; if this branch is still on the old int-pair index, then `point_uid` may not even
  --    be NOT NULL and dropping the pair would leave the table with NO enforced address. Checking the
  --    index definition rather than the drizzle journal deliberately: the journal records intent, the
  --    catalog records what is actually true of THIS branch.
  SELECT indexdef INTO unique_def
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'area_bindings_unique';

  IF unique_def IS NULL OR unique_def NOT LIKE '%point_uid%' THEN
    RAISE EXCEPTION 'refusing to drop the area_bindings int pair: 0047 has not landed here — area_bindings_unique is %',
      coalesce(unique_def, '(missing)');
  END IF;

  -- 2. Nothing may still depend on either column. 0047 removed the FK and both indexes, but an index,
  --    constraint, or default added since would make the DROP either fail mid-migration or (worse,
  --    with CASCADE, which this migration never uses) silently take a dependent with it. Enumerated
  --    from the catalog so the failure names the dependent instead of leaving a bare 2BP01.
  SELECT string_agg(DISTINCT src, ', ') INTO dependents FROM (
    SELECT 'index ' || i.relname AS src
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
     WHERE x.indrelid = 'public.area_bindings'::regclass
       AND a.attname IN ('point_system_id', 'point_id')
    UNION ALL
    SELECT 'constraint ' || c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.area_bindings'::regclass
       AND a.attname IN ('point_system_id', 'point_id')
  ) d;

  IF dependents IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop the area_bindings int pair: still referenced by %', dependents;
  END IF;

  -- 3. The equivalence, re-asserted at the last moment it can be. See the header: after the DROP
  --    there is no second address left to disagree with `point_uid`, so any divergence that crept in
  --    since 0047 becomes undetectable. A NULL half is fine — 0047 made both columns NULLable
  --    precisely so writers could stop setting them — so only rows that still CARRY a pair are
  --    checked, and a pair that matches no `point_info` row yields NULL and is caught the same way.
  SELECT string_agg(format('(%s, %s/%s: uid=%s pair=%s.%s → %s)',
                           ab.area_id, ab.role, ab.metric_type,
                           ab.point_uid, ab.point_system_id, ab.point_id, pi.point_uid), ', ')
    INTO disagreeing
    FROM area_bindings ab
    LEFT JOIN point_info pi
      ON pi.system_id = ab.point_system_id AND pi.id = ab.point_id
   WHERE ab.point_system_id IS NOT NULL
     AND ab.point_id IS NOT NULL
     AND pi.point_uid IS DISTINCT FROM ab.point_uid;

  IF disagreeing IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to drop the area_bindings int pair: point_uid disagrees with it on: %',
      disagreeing;
  END IF;

  RAISE NOTICE 'checks ok: dropping the int pair from % area_bindings row(s); 0047 is in place and point_uid is the sole address',
    total_rows;
END $$;--> statement-breakpoint
-- NO CASCADE — check 2 has already proven there is nothing to cascade to, and if that changes between
-- the check and here the DROP must abort rather than quietly remove a dependent.
ALTER TABLE "area_bindings" DROP COLUMN IF EXISTS "point_system_id";--> statement-breakpoint
ALTER TABLE "area_bindings" DROP COLUMN IF EXISTS "point_id";
