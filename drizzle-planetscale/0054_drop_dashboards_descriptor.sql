-- 0054 config-v4 Phase 14 stage 16 — `dashboards.descriptor` leaves the database.
--
-- One column, one table. `ALTER TABLE dashboards DROP COLUMN descriptor` — no index, no constraint, no
-- data copied, and **no `CASCADE` anywhere in this file**. After this there is genuinely one dashboard
-- shape: the v4 node-tree document in `dashboards.doc`.
--
-- ============================================================================================
-- 🛑 IRREVERSIBLE AND NOT RECONSTRUCTIBLE. This is the 0051 kind of drop, not the 0052 kind.
--
-- 0052 could be cheap because `areas.legacy_system_id` was set-identical to a surviving table, so the
-- column could be rebuilt with one UPDATE. **`descriptor` has no such twin.** It is a v3 document that
-- `doc` SUPERSEDED rather than duplicated: `doc` is the product of `rewriteV3ToV4` plus every edit made
-- through the v4 `PUT` since, so it is neither a superset nor a lossless encoding of the v3 shape (v3
-- card ids such as `chart:lines` are deliberately NOT carried into `doc` — see the stage-8 note in
-- the config-v4 epic record). Once this lands, the only copy of the old descriptors is a
-- backup.
--
-- 🛑 **TAKE THE BACKUP FIRST, ON BOTH ENVIRONMENTS**, before applying:
--
--      pg_dump --data-only --table=public.dashboards "<url>" > .context/backups/dashboards-<env>-<date>.sql
--
-- `.context/` is gitignored and must stay that way — that dump carries dashboard config and this repo
-- is PUBLIC. The PITR window and the 2-hourly R2 `pg_dump` are the backstop; this one-off is the
-- convenient copy. It CANNOT go stale between the dump and the apply, because nothing in the deployed
-- build writes this column any more (that is precisely what stage 15 established and what G3 below
-- re-proves on the target database).
--
-- An in-migration archive table (`CREATE TABLE dashboards_descriptor_archive AS SELECT id, descriptor
-- …`) was CONSIDERED AND REJECTED: it is atomic with the drop, which sounds attractive, but the
-- staleness it protects against cannot occur (no writer), and it would leave a permanent undeclared
-- table on prod that needs its own migration to remove — reintroducing, as a table, exactly the second
-- shape this stage exists to delete.
-- ============================================================================================
--
-- 🛑 DEPLOY THE CODE FIRST — drops INVERT the project's usual "migration leads code" rule (learned by
-- breaking prod during 0037, restated by 0052). A projection-less `.select()` expands to the columns
-- declared in the RUNNING build, and — the specific hazard here — the running build up to and including
-- stage 15 contains a hand-written `INSERT INTO dashboards (… , descriptor) VALUES (…, '{}'::jsonb)` in
-- `createDashboard`. **That INSERT 500s the moment this column is gone.** Stage 15 already removed the
-- field from `schema.ts`; THIS migration's own PR removes that last INSERT.
--
-- 🛑🛑 **AND THAT MAKES THIS PR AND THIS MIGRATION HARD-COUPLED. THERE IS NO ORDER WITH NO WINDOW.**
-- This corrects stage 15's plan, which recorded stage 16 as "just the DROP plus restoring the drizzle
-- insert" and assumed the usual deploy-then-drop sequence covered it. It does not, and the smoke run on
-- this PR is what found it (`POST /api/v4/dashboards` → 500, pg `23502 null value in column
-- "descriptor"`), not a code review:
--
--   * **Deploy this PR, then apply** → between the two, `createDashboard` omits `descriptor`, which is
--     still `NOT NULL` **with no DB default**, so it 23502s.
--   * **Apply, then deploy this PR** → between the two, the OLD build's INSERT names a column that no
--     longer exists, so it 42703s.
--
-- Both windows break exactly ONE operation — `POST /api/v4/dashboards`, i.e. creating a new dashboard.
-- Every read, every doc `PUT`, every area/sharing mutation and the whole ingest path are untouched,
-- because nothing else names this column.
--
-- ✅ **RULED 2026-07-31: DEPLOY FIRST, THEN APPLY PROMPTLY, AND ACCEPT THE WINDOW.** The alternative
-- was the textbook expand step — give the column a default in its OWN migration, applied to prod AND
-- dev BEFORE this PR merges, after which the new code's insert is valid both before and after the DROP
-- and every order is safe:
--
--      ALTER TABLE dashboards ALTER COLUMN descriptor SET DEFAULT '{}'::jsonb;   -- NOT DONE, see below
--
-- **Rejected deliberately, and the reason is a standing project decision rather than a judgement about
-- this migration.** LiveOne has ONE user (share tokens are the only genuine multi-party surface), and
-- the recorded preference is *"a simple change with a short outage over machinery that minimises
-- downtime"*. Weighed concretely: the expand step protects one owner-only, low-frequency operation for
-- a few minutes, and costs an extra migration that must itself be written, numbered, reviewed and
-- applied to two environments in a fixed order BEFORE this one can land — more moving parts and more
-- chances to get an ordering wrong, which is precisely the machinery the preference exists to refuse.
--
-- (Stage 15 rejected a DB default on the different, and wrong, ground that it "buys nothing that
-- survives stage 16": true of the default itself, but it buys the ORDERING. The ordering is what was
-- missing; it is simply not worth the extra step here. Worth remembering on a system with more than
-- one user, where the same shape would need the expand.)
--
-- Order:
--
--      1. MERGE this migration's PR and let Vercel deploy it. Confirm `Ready` + aliased, `/api/health`
--         200, and `/api/health?migrations=1` reporting `expected: 55` — that count is the journal
--         length IN THE RUNNING BUILD, which makes it a precise deploy probe (the 0053 technique).
--      2. Apply THIS migration to prod `sydney`.
--      3. Post-check the CATALOG (see below), not the migrator's exit line.
--      4. Apply to `liveone-dev` — see the two dev-specific hazards below FIRST — and re-post-check.
--
-- ⚠️ **`liveone-dev` IS SHARED INFRASTRUCTURE AND THE DROP RULE APPLIES TO IT EXACTLY AS TO PROD.**
-- Phase 13 broke dev by forgetting this. Two concrete hazards, both specific to the dev leg:
--
--   (a) **Every OTHER live worktree/preview is a "running build" too**, and the coupling above applies
--       to each of them independently. Any branch not rebased past this PR still carries the
--       `descriptor` INSERT, so after the dev column is dropped `POST /api/v4/dashboards` 42703s there
--       — which also reddens `scripts/utils/v4-surface-smoke.ts`, since it creates scratch dashboards
--       on every run and aborts when create fails. Rebase or pause the other agents before applying to
--       dev. (Symmetrically, a branch that HAS been rebased past this PR cannot create a dashboard on
--       dev until the dev apply happens — measured, on this very branch.) At the time of writing that
--       is **stage 20**, which the orchestrator is warning directly; stage 19 has already merged.
--   (b) **The 2-hourly prod→dev sync ASSERTS SCHEMA PARITY and will fail loudly in the window between
--       the two applies.** `assertManifestSchemaParity` (lib/readings/prod-dev-sync.ts) compares the
--       prod and dev column sets for every manifest table and throws
--       `prod/dev schema mismatch for sync manifest (prod-only: …; dev-only: dashboards.descriptor)`.
--       This is a GOOD failure — it fences the window rather than corrupting it, and it cannot produce
--       a NOT NULL violation on dev because the parity check runs before any INSERT — but it means the
--       prod→dev window should be minutes, not hours, and a red sync run in between is expected rather
--       than alarming. (`columnsOf()` takes its column list from the DEV catalog, so nothing silently
--       adapts; and `dashboards` is `mode: "full"`, so nothing partial is written either.)
--
-- **No maintenance window, no queue pause.** `ALTER TABLE … DROP COLUMN` is catalog-only in Postgres —
-- the attribute is marked dropped, there is no table rewrite — so the `ACCESS EXCLUSIVE` lock is held
-- for microseconds on a 4-row table that is off the ingest path entirely. Consider
-- `SET lock_timeout = '5s'` on the session so a long-running reader makes this fail fast rather than
-- queue behind a lock.
--
-- 🛑 A MISSING MIGRATION FILE LOOKS IDENTICAL TO A SUCCESSFUL APPLY. `db:pg:migrate` run from a tree
-- lacking this file — or on a branch whose journal already names it — prints "migrations applied
-- successfully" and does nothing. Only the CATALOG distinguishes them:
--
--      SELECT count(*) FROM pg_attribute
--       WHERE attrelid = 'public.dashboards'::regclass AND attname = 'descriptor' AND NOT attisdropped;
--
-- Must be 0 afterwards. Related: **`db:pg:migrate` swallows `RAISE NOTICE`**, so the inventory below is
-- invisible in its output — capture it BY HAND before applying, or the record is lost. Every GATE is a
-- `RAISE EXCEPTION`, which is not swallowed.
--
-- ## Measured precondition, BEFORE the gates were written (this is the part that changed the design)
--
--                                   | rows | descriptor = '{}' | descriptor = v3 object | doc v4-shaped
--      `liveone-dev`  (2026-07-31)  |    4 |                 0 |                      4 |             4
--      prod `sydney`  (2026-07-31)  |    4 |                 0 |                      4 |             4
--
-- Plus, on BOTH: raw uuids inside a descriptor = **0** (so G3b passes and G5 is exhaustive), and rows
-- whose `descriptor` names an area their `doc` does not = **0** (so G5 passes). The two environments
-- are the same shape, which is the useful part: unlike 0053 — where a prod run reporting dev's count
-- would itself have been the red flag — there is no per-environment expected number to get wrong here.
-- Prod was measured by the orchestrator through a short-TTL `pg_read_all_data` role, confirmed prod by
-- a 24-second ingest lag, role deleted afterwards.
--
-- 🛑 **THE OBVIOUS GATE WOULD HAVE ABORTED ON EVERY ROW.** The brief for this stage proposed asserting
-- that every row's `descriptor` is the inert `{}` stage 15 writes. It is not, and could not be: stage
-- 15 stopped *writing* the column, it did not blank it. All four dev rows still carry their full,
-- unmodified v3 descriptor (`version: 3`, 1–13 sections, 386–782 bytes) — indeed stage 15's own proof
-- was that their md5s never change. `{}` is only what a dashboard CREATED after stage 15 deployed would
-- carry, and none exist. **It would have aborted on all EIGHT rows across BOTH environments** (prod is
-- 0 inert / 4 version-3 too). Measure, do not assume.
--
-- ## What the gates below actually prove, and the one that is the 0053 trick in weaker form
--
-- G0/G1 are the usual "this is the state this migration was written against" catalog checks. G4 is the
-- dependent sweep — read its comment, it is the one gate that failed its own negative control on the
-- first draft, and the reason is not obvious. The two that carry real content are G2 and G5:
--
--   * **G2 — the REPLACEMENT exists on every row.** `doc` must be non-null, an object, `version: 4`,
--     and carry a `root`, for every single row. This is the precondition that justifies the
--     destruction: the successor document must be present before its predecessor is destroyed. A row
--     whose `doc` were empty would lose its only content to this migration.
--
--   * **G5 — THE ORACLE, i.e. 0053's "a migration can carry its own oracle", adapted.** 0053 needed to
--     prove an ENCODER it was about to run; a DROP runs no computation, so there is no encoder to
--     verify and the trick does not transfer literally. What it transfers to is the CLAIM that
--     justifies the drop — "`doc` superseded `descriptor`" — which until now lives only in a PR body.
--     G5 checks it against the target database at apply time: **every `ar_…` area ref that appears in a
--     row's `descriptor` must also appear in that row's `doc`.** Measured 0 missing across 4/4 rows on
--     dev, 15/15 refs. A dashboard whose descriptor named an area its document no longer references
--     would be a real, silent loss of composition, and it aborts here rather than in a screenshot
--     three weeks later.
--
--     G5 is the ONE gate that can legitimately fire: an owner who deleted an area from a dashboard
--     through the v4 editor after stage 14 landed has diverged the two documents ON PURPOSE, and the
--     lost ref is not a defect. **Run the probe in this migration's PR body against prod before
--     applying** — if it reports a non-zero `missing_from_doc`, that divergence must be understood and
--     the gate consciously removed, NOT worked around with `CASCADE` (which is about a different thing
--     entirely and appears nowhere in this file).
--
--     G5 is only sound if the comparison is exhaustive, so G3 also refuses to run when a `descriptor`
--     contains a RAW area uuid: the regex compares `ar_` refs, and a raw-uuid ref would be silently
--     ignored rather than counted as missing. Measured 0 raw uuids in 4/4 dev descriptors, consistent
--     with the 16/16-`ar_`-on-both-environments measurement recorded at lib/areas/ref.ts:8.
--
--   * **G3 — every descriptor is a SHAPE WE RECOGNISE** (`{}` or a `version: 3` object). An
--     unrecognised shape means an unknown writer, which would directly contradict the inertness stage
--     15 established and this whole PR depends on. Reported as an inventory; aborts on a surprise.
--
-- Preconditions read the CATALOG and the live rows, never the drizzle journal: the journal records
-- INTENT, the catalog records what is true of THIS branch. All of it sits in `DO` blocks with
-- `RAISE EXCEPTION`, inside the migrator's transaction — validation INSIDE the migration is the only
-- check that cannot be raced between probe and apply, and a failed assertion rolls the DROP back.
--
-- Not idempotent, and deliberately not: G0 turns a second run into an explicit failure rather than a
-- confusing no-op. The journal is what prevents a second run. To re-check a branch, run the gate
-- predicates by hand as plain `SELECT`s.
--
-- ⚠️ **KNOWN, PRE-EXISTING DRIZZLE-KIT SNAPSHOT DRIFT — read before running `db:pg:generate`.** The
-- latest drizzle snapshot (`meta/0052_snapshot.json`) still declares `dashboards.descriptor`, because
-- stage 15 removed the field from `schema.ts` without a generated migration and 0053 was hand-written
-- (a pure data migration, so it needed no snapshot). This file is hand-written too. `0054_snapshot.json`
-- IS included alongside it, hand-written as the snapshot drizzle-kit would have produced — 0052's with
-- the `descriptor` column removed, `prevId` chained to 0052 — so that a later `db:pg:generate` reports
-- *No schema changes* instead of emitting a SECOND `DROP COLUMN "descriptor"` on top of whatever it is
-- actually being run for. Without it, stage 21's rename migration would have quietly carried a
-- duplicate drop that fails on apply.

-- ── Gates. All of them, before anything is touched. ──────────────────────────────────────────
DO $$
DECLARE
  col_attnum        smallint;
  n_dashboards      bigint;
  n_doc_bad         bigint;
  n_desc_empty      bigint;
  n_desc_v3         bigint;
  n_desc_other      bigint;
  n_desc_raw_uuid   bigint;
  n_desc_refs       bigint;
  n_rows_missing    bigint;
  n_refs_missing    bigint;
  n_deps            bigint;
  deps_desc         text;
BEGIN
  -- ── G0. The catalog says this is the state the migration was written against. ───────────────
  SELECT attnum INTO col_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.dashboards'::regclass AND attname = 'descriptor' AND NOT attisdropped;

  IF col_attnum IS NULL THEN
    RAISE EXCEPTION '0054: dashboards.descriptor is already gone — this migration is ALREADY APPLIED to this branch; reconcile by hand rather than recording a no-op as applied';
  END IF;

  -- ── G1. Not an empty database. A vacuous gate is the danger, not the empty table. ───────────
  SELECT count(*) INTO n_dashboards FROM dashboards;
  IF n_dashboards = 0 THEN
    RAISE EXCEPTION '0054: dashboards is EMPTY — this is not a database anything has been served from, and every content gate below would pass VACUOUSLY; refusing to drop blind';
  END IF;

  -- ── G2. The REPLACEMENT document exists, on every row, before its predecessor is destroyed. ──
  SELECT count(*) INTO n_doc_bad
  FROM dashboards
  WHERE doc IS NULL
     OR jsonb_typeof(doc) <> 'object'
     OR NOT (doc ? 'root')
     OR COALESCE(doc ->> 'version', '') <> '4';

  IF n_doc_bad <> 0 THEN
    RAISE EXCEPTION '0054: % of % dashboard(s) have no usable v4 doc (null, non-object, no root, or version <> 4) — `doc` is what SUPERSEDES `descriptor`, so dropping the column would leave those rows with no composition at all',
      n_doc_bad, n_dashboards;
  END IF;

  -- ── G3. Every descriptor is a shape we recognise, and none hides a raw-uuid area ref. ───────
  -- `{}` = minted after stage 15 stopped writing the column; `version: 3` = every pre-existing row.
  -- Anything else means an unknown writer, which contradicts the inertness this drop depends on.
  SELECT
    count(*) FILTER (WHERE descriptor = '{}'::jsonb),
    count(*) FILTER (WHERE descriptor <> '{}'::jsonb
                       AND jsonb_typeof(descriptor) = 'object'
                       AND COALESCE(descriptor ->> 'version', '') = '3')
  INTO n_desc_empty, n_desc_v3
  FROM dashboards;

  n_desc_other := n_dashboards - n_desc_empty - n_desc_v3;
  IF n_desc_other <> 0 THEN
    RAISE EXCEPTION '0054: % descriptor(s) are NEITHER the inert {} nor a version-3 object — an unrecognised shape means something still writes this column, which is exactly what stage 15 established is no longer true. Understand it before dropping',
      n_desc_other;
  END IF;

  -- G5 compares `ar_` refs. A raw-uuid area ref would be silently ignored rather than counted as
  -- missing, so its presence makes G5 non-exhaustive and this refuses to run.
  SELECT count(*) INTO n_desc_raw_uuid
  FROM dashboards
  WHERE descriptor::text ~ '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

  IF n_desc_raw_uuid <> 0 THEN
    RAISE EXCEPTION '0054: % descriptor(s) contain a RAW uuid — G5 below compares ar_ refs only, so it would not be exhaustive on this database. Inspect those rows by hand',
      n_desc_raw_uuid;
  END IF;

  RAISE NOTICE '0054 inventory: % dashboard(s); descriptors = % inert {} + % version-3; all % docs are v4-shaped',
    n_dashboards, n_desc_empty, n_desc_v3, n_dashboards;

  -- ── G4. ZERO catalog dependents on the column — ANY deptype. ────────────────────────────────
  -- 🛑 This gate was WRONG on its first draft and the negative control caught it. The obvious
  -- formulation — `pg_index … col_attnum = ANY(indkey)` plus `pg_constraint … conkey @> ARRAY[…]`,
  -- plus a `pg_depend` sweep filtered to `deptype <> 'a'` — passed cleanly with an
  -- `CREATE INDEX ON dashboards ((descriptor ->> 'version'))` sitting on the table, and the column
  -- dropped, taking that index silently with it. Two independent reasons, both worth knowing:
  --
  --   * an EXPRESSION index stores 0 in `indkey`, not the attnum, so `indkey` cannot see it; and
  --   * an index's dependency on a column is `deptype = 'a'` (auto), which the "skip the column's own
  --     attribute wiring" filter threw away. Measured on this database: every real dependent of a
  --     `dashboards` column — `dashboards_user_idx`, `dashboards_owner_alias_unique`,
  --     `dashboards_legacy_id_unique`, the `created_at`/`updated_at`/`revision` defaults — is `'a'`.
  --
  -- And `DROP COLUMN` does not need `CASCADE` to take an index with it: dropping a column silently
  -- drops every index over it. So `CASCADE`-avoidance alone buys nothing here; the gate has to be the
  -- protection. `descriptor` has exactly ZERO pg_depend rows on this database (measured), so the
  -- correct gate is the unfiltered one — anything at all is a surprise.
  -- `deptype` is `"char"`, and `text || "char"` is ambiguous — cast it explicitly.
  SELECT count(*), string_agg(pg_describe_object(d.classid, d.objid, d.objsubid) || ' [' || d.deptype::text || ']', '; ')
  INTO n_deps, deps_desc
  FROM pg_depend d
  WHERE d.refobjid = 'public.dashboards'::regclass
    AND d.refobjsubid = col_attnum;

  IF n_deps <> 0 THEN
    RAISE EXCEPTION '0054: % catalog dependent(s) on dashboards.descriptor — %. DROP COLUMN would take them with it WITHOUT a CASCADE and without saying so. Understand each one before dropping',
      n_deps, deps_desc;
  END IF;

  -- ── G5. THE ORACLE. "doc superseded descriptor", verified on THIS database at apply time. ────
  -- Every ar_ area ref a row's descriptor names must also appear in that row's doc. See the header for
  -- why this is 0053's trick in its transferable form, and for the one legitimate way it can fire.
  SELECT
    count(*) FILTER (WHERE missing > 0),
    COALESCE(sum(missing), 0),
    COALESCE(sum(refs), 0)
  INTO n_rows_missing, n_refs_missing, n_desc_refs
  FROM (
    SELECT
      (SELECT count(DISTINCT m[1])
         FROM regexp_matches(d.descriptor::text, 'ar_[0-9abcdefghjkmnpqrstvwxyz]{26}', 'g') m) AS refs,
      (SELECT count(*) FROM (
          SELECT DISTINCT m[1] AS r
            FROM regexp_matches(d.descriptor::text, 'ar_[0-9abcdefghjkmnpqrstvwxyz]{26}', 'g') m
          EXCEPT
          SELECT DISTINCT m2[1]
            FROM regexp_matches(d.doc::text, 'ar_[0-9abcdefghjkmnpqrstvwxyz]{26}', 'g') m2
       ) x) AS missing
    FROM dashboards d
  ) t;

  IF n_rows_missing <> 0 THEN
    RAISE EXCEPTION '0054: % dashboard(s) name % area ref(s) in `descriptor` that their `doc` does NOT reference — the claim that `doc` superseded `descriptor` does not hold on this database. Either a composition was lost in the v3->v4 rewrite (a defect: STOP), or an owner deliberately removed those areas through the v4 editor (not a defect: re-measure, then remove this gate consciously). Nothing has been dropped',
      n_rows_missing, n_refs_missing;
  END IF;

  RAISE NOTICE '0054 G5 oracle: % descriptor area ref(s) across % row(s); 0 absent from the corresponding doc', n_desc_refs, n_dashboards;

  RAISE NOTICE '0054 pre-check OK: dropping dashboards.descriptor (attnum %) from % row(s)', col_attnum, n_dashboards;
END $$;
--> statement-breakpoint

-- ── The drop. NO CASCADE. ────────────────────────────────────────────────────────────────────
ALTER TABLE "dashboards" DROP COLUMN "descriptor";--> statement-breakpoint

-- ── Post-state, asserted rather than assumed — inside the same transaction, so a failure here
--    rolls the DROP back. ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n_dashboards bigint;
  surviving    text[];
  expected     text[] := ARRAY[
    'id', 'legacy_id', 'owner_user_id', 'name', 'slug', 'doc', 'revision', 'created_at', 'updated_at'
  ];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.dashboards'::regclass AND attname = 'descriptor' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0054: dashboards.descriptor still exists after the DROP';
  END IF;

  -- Exactly ONE column left, not two. An explicit expected set, not a count.
  SELECT array_agg(attname ORDER BY attname) INTO surviving
  FROM pg_attribute
  WHERE attrelid = 'public.dashboards'::regclass AND attnum > 0 AND NOT attisdropped;

  IF NOT (surviving @> expected AND expected @> surviving) THEN
    RAISE EXCEPTION '0054: dashboards columns after the drop are % — expected exactly %; the wrong thing was dropped or something else changed',
      surviving, (SELECT array_agg(e ORDER BY e) FROM unnest(expected) e);
  END IF;

  SELECT count(*) INTO n_dashboards FROM dashboards;
  IF n_dashboards = 0 THEN
    RAISE EXCEPTION '0054: dashboards is empty after the drop — rows were lost';
  END IF;

  IF EXISTS (SELECT 1 FROM dashboards WHERE doc IS NULL) THEN
    RAISE EXCEPTION '0054: a dashboard has a NULL doc after the drop';
  END IF;

  RAISE NOTICE '0054 OK: dashboards.descriptor dropped; % row(s) intact, every doc present', n_dashboards;
END $$;
