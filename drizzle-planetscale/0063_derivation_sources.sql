-- 0063 block-model increment 1 — a derivation's inputs become typed rows, and its SITE stops being
-- configured.
--
-- `derivations.source_points jsonb` gains a real relational twin, `derivation_sources` (one row per
-- input slot), and `derivations.area_id` is demoted to a dual-written vestige: nullable, ON DELETE
-- SET NULL, read by nothing after this PR's lib rewrite. 0064 drops it.
--
-- ## Why this exists
--
-- A jsonb object of point uuids can name a point on any device, spell its key `"signl"`, or hold a
-- uuid that resolves to nothing at all — and every one of those is accepted silently. Today
-- `resolveRunDetector` only `console.warn`s and the detector then derives nothing, forever. The
-- table makes all three unrepresentable: a PK of (derivation_id, slot), a CHECK over the per-kind
-- slot vocabulary, and a composite FK that PROVES `device_id` is the point's own device rather than
-- trusting a copy.
--
-- That last one is what lets a detector's site be DERIVED instead of configured. Before this, a
-- detector's site was `area_id` — a column that could disagree with where its points actually live,
-- and nothing checked. After it: owner point → `points.device_id` → `devices.rid`.
--
-- ## 🛑 The owner slot is energy-then-signal, and this database is why
--
-- The owner point is `energy` if present, else `signal` (`power` for hws-model). That precedence is
-- not a preference. Measured on prod:
--
--   * run-detector/generator: signal on device **14** (Daylesford Generator, Engine Speed),
--     energy on device **1** (Daylesford Selectronic, Import) — and the area's legacy handle is 1.
--   * run-detector/ev (Kinkora): signal AND energy both on device 6.
--   * run-detector/ev (Kutis): signal on 13, energy NULL.
--   * hws-model: power on device 6.
--
-- Signal-first would move the generator detector's `legacyHandle` from 1 to 14, and with it a live
-- KV key and the `/device/{rid}/run-periods` address of 632 stored intervals. **G5 is the gate that
-- proves the collapse preserves every handle**, and it is checked before anything is written.
--
-- ## Ordering: this migration is SAFE IN EITHER DIRECTION, and that is deliberate
--
-- Everything here is additive except `area_id`'s NOT NULL and FK action, both of which LOOSEN. The
-- running build writes `area_id` on every insert and still reads it; nothing it does becomes
-- illegal. The new table is written by nobody until the code lands, and read by nobody before that.
-- So: apply first, deploy after, with no window — which is the whole reason this PR dual-writes
-- instead of cutting over. 0064 is the one with an ordering constraint.
--
-- ## NOT NULL and SET NULL go together
--
-- `ON DELETE SET NULL` on a `NOT NULL` column does not clear the reference — it ABORTS the delete
-- with a not-null violation, i.e. it behaves as NO ACTION with a worse error message. The pair is
-- what lets `prod-dev-sync` drop its `derivations.area_id` repoint with a zero window, so applying
-- one without the other would silently keep the old behaviour while the sync stopped compensating
-- for it. G10 checks `confdeltype` by name for exactly this class of silent no-op.
--
-- ## The two helper unique indexes
--
-- `points_id_device_unique` and `derivations_id_kind_role_unique` are redundant-but-legal: their
-- leading column is already the PK. They exist ONLY as composite-FK targets — Postgres requires a
-- unique index over the referenced columns — and that is what turns three denormalised columns from
-- copies-that-can-rot into columns the database proves. They must be created BEFORE the FKs;
-- drizzle-kit generated them after, which would have failed at apply.
--
-- ## Gates
--
-- G0 double-apply · G1 non-vacuity · G2 every jsonb uuid resolves · G3 required slot per kind ·
-- G4 slot vocabulary · 🛑G5 handle equivalence · 🛑G6 site resolution unchanged · G7 uniqueness
-- pre-check. Then: G8 coverage both directions · 🛑G9 nothing was recreated · G10 catalog by name
-- including FK actions.
--
-- Every gate is a `RAISE EXCEPTION` inside the migrator's transaction, so a failure rolls back the
-- whole migration rather than recording a half-apply as applied.

-- ── G0–G7. Everything asserted BEFORE anything is written. ──────────────────────────────────────
DO $$
DECLARE
  n_derivations  bigint;
  n_bad          bigint;
  bad_desc       text;
BEGIN
  -- G0. Double-apply guard. A missing migration file looks identical to a successful apply, so the
  -- catalog is the authority, not the journal.
  IF to_regclass('public.derivation_sources') IS NOT NULL THEN
    RAISE EXCEPTION '0063: derivation_sources already exists — this migration is ALREADY APPLIED on this branch; reconcile by hand rather than recording a no-op as applied';
  END IF;
  IF to_regclass('public.derivations') IS NULL THEN
    RAISE EXCEPTION '0063: derivations does not exist — this is not the shape this migration was written against';
  END IF;

  -- G1. Non-vacuity. THIS is the danger, not an empty table: every gate below passes over zero rows
  -- and proves nothing, and G5/G6 are the entire justification for the collapse. Measured: prod 4,
  -- dev 4.
  SELECT count(*) INTO n_derivations FROM derivations;
  IF n_derivations = 0 THEN
    RAISE EXCEPTION '0063: derivations is EMPTY — every equivalence gate below would pass VACUOUSLY, so this would collapse a detector''s site onto its sources and assert nothing at all; refusing. If a genuinely fresh environment ever needs this, run the gate predicates by hand and remove G1 consciously';
  END IF;

  -- G2. Every non-null jsonb source uuid resolves to a points row. This is what makes the new
  -- table's `device_id NOT NULL` satisfiable at all; today a dangling uuid is only a console.warn.
  SELECT count(*), string_agg(format('%s[%s]=%s', id, slot, point_id), '; ')
  INTO n_bad, bad_desc
  FROM (
    SELECT d.id, k.key AS slot, (d.source_points->>k.key)::uuid AS point_id
    FROM derivations d, LATERAL jsonb_object_keys(d.source_points) k(key)
    WHERE (d.source_points->>k.key) IS NOT NULL
  ) s
  WHERE NOT EXISTS (SELECT 1 FROM points p WHERE p.id = s.point_id);
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % source uuid(s) resolve to no points row — %. The backfill cannot give them a device_id, and a dangling source is a detector that derives nothing. Repair the binding first', n_bad, bad_desc;
  END IF;

  -- G3. Required slot present per kind. A run-detector without `signal` and an hws-model without
  -- `power` have nothing to follow.
  SELECT count(*), string_agg(format('%s(%s)', id, kind), '; ')
  INTO n_bad, bad_desc
  FROM derivations d
  WHERE (d.kind = 'run-detector' AND (d.source_points->>'signal') IS NULL)
     OR (d.kind = 'hws-model'    AND (d.source_points->>'power')  IS NULL);
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % derivation(s) are missing their required source slot — %', n_bad, bad_desc;
  END IF;

  -- G4. Slot vocabulary, per kind — the CHECK does not exist yet, so this is what NAMES a typo'd
  -- key ("signl") instead of failing later with a bare 23514 over a row you cannot see.
  SELECT count(*), string_agg(format('%s(%s) key=%L', id, kind, slot), '; ')
  INTO n_bad, bad_desc
  FROM (
    SELECT d.id, d.kind, k.key AS slot
    FROM derivations d, LATERAL jsonb_object_keys(d.source_points) k(key)
  ) s
  WHERE NOT ((s.kind = 'run-detector' AND s.slot IN ('signal','energy','boundary'))
          OR (s.kind = 'hws-model'    AND s.slot = 'power'));
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % source key(s) are not legal for their derivation''s kind — %. Fix the key before it becomes a CHECK violation with no row named', n_bad, bad_desc;
  END IF;

  -- 🛑 G5. EQUIVALENCE — the gate this whole migration rests on. For every derivation, the site
  -- derived from its OWNER point must be the site it is filed under today:
  --   (a) the area's legacy handle == the owner device's rid  ← what proves `legacyHandle` survives
  --   (b) the owner device is a MEMBER of that area           ← proves the collapse is not a move
  -- Owner = energy → signal → power, in that order. See the header for why.
  SELECT count(*), string_agg(
           format('%s(%s/%s): handle=%s owner_rid=%s member=%s',
                  o.id, o.kind, COALESCE(o.role,'-'), COALESCE(lh.handle::text,'NULL'),
                  o.owner_rid, o.is_member),
           '; ')
  INTO n_bad, bad_desc
  FROM (
    SELECT d.id, d.kind, d.role, d.area_id, p.device_id AS owner_device, dv.rid AS owner_rid,
           EXISTS (SELECT 1 FROM area_members am
                    WHERE am.area_id = d.area_id AND am.device_id = p.device_id) AS is_member
    FROM derivations d
    JOIN points  p  ON p.id = COALESCE((d.source_points->>'energy')::uuid,
                                       (d.source_points->>'signal')::uuid,
                                       (d.source_points->>'power')::uuid)
    JOIN devices dv ON dv.id = p.device_id
  ) o
  LEFT JOIN legacy_handles lh ON lh.area_id = o.area_id
  WHERE lh.handle IS DISTINCT FROM o.owner_rid OR NOT o.is_member;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % derivation(s) would CHANGE SITE under the owner-point collapse — %. Each one addresses stored intervals and a live KV key by its handle, so this is not a rename. Establish the correct owner before applying', n_bad, bad_desc;
  END IF;

  -- 🛑 G6. SITE RESOLUTION unchanged. `resolveSiteForDetector` (lib/run-tracking/intensity.ts)
  -- finds the area whose battery binding prices a run. Today it fans out from EVERY member of
  -- `derivations.area_id`; after this PR it starts from the owner device alone. Old winner vs new
  -- winner, `IS NOT DISTINCT FROM` so two misses agree. This is the only thing standing between the
  -- collapse and silently re-pricing a year of runs against another site's tariff and emissions.
  --
  -- 🛑 Both ORDER BY terms are reproduced verbatim from that query and both are load-bearing:
  -- `area_bindings.ordinal` (NOT `priority` — it must agree with the fold, lib/battery-provenance/
  -- load.ts), then `area_id` (the query fans across every area a device belongs to, and `ordinal` is
  -- only meaningful within one; device 13 is in three areas, two carrying a battery/power binding,
  -- so without the tiebreak this is a live coin-flip).
  SELECT count(*), string_agg(format('%s: old=%s new=%s', id, COALESCE(old_site::text,'NONE'), COALESCE(new_site::text,'NONE')), '; ')
  INTO n_bad, bad_desc
  FROM (
    SELECT d.id,
           -- OLD: any area reachable from any member of the detector's area.
           (SELECT sib.area_id
              FROM area_members member
              JOIN area_members sib ON sib.device_id = member.device_id
              JOIN area_bindings ab ON ab.area_id = sib.area_id
                                   AND ab.role = 'battery' AND ab.metric_type = 'power'
              JOIN points bp  ON bp.id = ab.point_uid
              JOIN devices bd ON bd.id = bp.device_id
              JOIN areas a    ON a.id = sib.area_id
             WHERE member.area_id = d.area_id
             ORDER BY ab.ordinal, sib.area_id
             LIMIT 1) AS old_site,
           -- NEW: any area the OWNER device itself belongs to.
           (SELECT sib.area_id
              FROM area_members sib
              JOIN area_bindings ab ON ab.area_id = sib.area_id
                                   AND ab.role = 'battery' AND ab.metric_type = 'power'
              JOIN points bp  ON bp.id = ab.point_uid
              JOIN devices bd ON bd.id = bp.device_id
              JOIN areas a    ON a.id = sib.area_id
             WHERE sib.device_id = p.device_id
             ORDER BY ab.ordinal, sib.area_id
             LIMIT 1) AS new_site
    FROM derivations d
    JOIN points p ON p.id = COALESCE((d.source_points->>'energy')::uuid,
                                     (d.source_points->>'signal')::uuid,
                                     (d.source_points->>'power')::uuid)
  ) s
  WHERE NOT (old_site IS NOT DISTINCT FROM new_site);
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % derivation(s) resolve to a DIFFERENT pricing site under the collapse — %. Applying would re-price their runs against another site''s tariff and emissions', n_bad, bad_desc;
  END IF;

  -- G7. Uniqueness pre-check on the partial index the backfill is about to be measured by, so a
  -- violation reports the offending rows instead of a bare 23505 naming only the index.
  SELECT count(*), string_agg(format('device=%s %s/%s x%s', device_id, kind, role, n), '; ')
  INTO n_bad, bad_desc
  FROM (
    SELECT p.device_id, d.kind, d.role, count(*) AS n
    FROM derivations d
    JOIN points p ON p.id = (d.source_points->>'signal')::uuid
    WHERE d.role IS NOT NULL
    GROUP BY 1,2,3
    HAVING count(*) > 1
  ) s;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % (signal device, kind, role) key(s) are not unique — %. derivation_sources_signal_role_unique would refuse the backfill', n_bad, bad_desc;
  END IF;

  RAISE NOTICE '0063 pre-gates OK: % derivation(s) collapse onto their owner points with no site change', n_derivations;
END $$;--> statement-breakpoint

-- ── The promise about the run history. `derived_intervals.derivation_id` is ON DELETE CASCADE, so
--    "no derivation was recreated" and "no interval was lost" are the same statement. G9 checks it.
CREATE TEMP TABLE _m0063_pre ON COMMIT DROP AS
SELECT (SELECT count(*) FROM derivations)                                    AS n_derivations,
       (SELECT count(*) FROM derived_intervals)                              AS n_intervals,
       (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM derivations)  AS id_md5;--> statement-breakpoint

-- ── The helper unique indexes. Redundant-but-legal; they exist ONLY as composite-FK targets, and
--    they must precede the FKs that reference them. See the header.
CREATE UNIQUE INDEX "points_id_device_unique" ON "points" USING btree ("id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "derivations_id_kind_role_unique" ON "derivations" USING btree ("id","kind","role");--> statement-breakpoint

-- ── The table. Constraints and indexes come AFTER the backfill, so a backfill defect is reported by
--    G8 over real rows rather than by a constraint over a row you cannot see.
CREATE TABLE "derivation_sources" (
	"derivation_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"point_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	CONSTRAINT "derivation_sources_pk" PRIMARY KEY("derivation_id","slot")
);--> statement-breakpoint

-- ── Backfill. One row per NON-NULL jsonb value: `"energy": null` is an ABSENT input, not a source
--    row (Kutis's EV detector has exactly that, and a NULL point_id is unrepresentable here by
--    design). `device_id` is read from `points`, which is what the FK below then proves.
INSERT INTO "derivation_sources" ("derivation_id","slot","point_id","device_id","kind","role")
SELECT d.id, k.key, (d.source_points->>k.key)::uuid, p.device_id, d.kind, d.role
FROM derivations d
CROSS JOIN LATERAL jsonb_object_keys(d.source_points) k(key)
JOIN points p ON p.id = (d.source_points->>k.key)::uuid
WHERE (d.source_points->>k.key) IS NOT NULL;--> statement-breakpoint

-- ── FK 1. Sources are pure wiring. Kept SEPARATE from FK 3 because FK 3 is MATCH SIMPLE and so is
--    not checked AT ALL when role IS NULL (the hws-model); without this, that row is unenforced.
ALTER TABLE "derivation_sources" ADD CONSTRAINT "derivation_sources_derivation_id_fk" FOREIGN KEY ("derivation_id") REFERENCES "public"."derivations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ── FK 2. Three jobs: device_id is PROVABLY the point's device; ON DELETE NO ACTION replaces the
--    protection area_id gave and aims it better (you cannot delete a point a live derivation reads);
--    ON UPDATE CASCADE carries device_id along when prod-dev-sync's `devices` idDrift leg repoints
--    points.device_id, which is why `devices` needs no new repoint child. 🛑 A silently-NO-ACTION
--    update action breaks that sync leg — G10 checks confupdtype by name.
ALTER TABLE "derivation_sources" ADD CONSTRAINT "derivation_sources_point_device_fk" FOREIGN KEY ("point_id","device_id") REFERENCES "public"."points"("id","device_id") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint

-- ── FK 3. kind/role are identity — the PATCH route already refuses to change them, which is what
--    makes denormalising them safe. This makes "safe" mean ENFORCED rather than asserted.
ALTER TABLE "derivation_sources" ADD CONSTRAINT "derivation_sources_derivation_kind_role_fk" FOREIGN KEY ("derivation_id","kind","role") REFERENCES "public"."derivations"("id","kind","role") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint

-- ── The CHECK. Per-KIND, deliberately: this refuses `power` on a run-detector, not merely a
--    misspelled slot. The cost is honest — a new `kind` needs a migration to widen it.
ALTER TABLE "derivation_sources" ADD CONSTRAINT "derivation_sources_slot_check" CHECK (("derivation_sources"."kind" = 'run-detector' AND "derivation_sources"."slot" IN ('signal','energy','boundary'))
       OR ("derivation_sources"."kind" = 'hws-model' AND "derivation_sources"."slot" = 'power'));--> statement-breakpoint

CREATE INDEX "derivation_sources_device_idx" ON "derivation_sources" USING btree ("device_id","kind","role");--> statement-breakpoint
CREATE INDEX "derivation_sources_point_idx" ON "derivation_sources" USING btree ("point_id","device_id");--> statement-breakpoint

-- ── One derivation per (device owning the SIGNAL point, kind, role). Restricted to slot='signal'
--    because it HAS to be: Kinkora's EV detector puts signal AND energy on device 6, so an index
--    spanning both slots would refuse a single legal detector's own rows.
CREATE UNIQUE INDEX "derivation_sources_signal_role_unique" ON "derivation_sources" USING btree ("device_id","kind","role") WHERE role IS NOT NULL AND slot = 'signal';--> statement-breakpoint

-- ── `derivations.area_id` becomes a vestige. NOT NULL and the FK action move TOGETHER — see the
--    header: SET NULL on a NOT NULL column aborts the delete instead of clearing it.
ALTER TABLE "derivations" DROP CONSTRAINT "derivations_area_id_areas_id_fk";--> statement-breakpoint
ALTER TABLE "derivations" ALTER COLUMN "area_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "derivations" ADD CONSTRAINT "derivations_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── G8–G10. What actually landed. ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  pre        _m0063_pre%ROWTYPE;
  n_rows     bigint;
  n_expected bigint;
  n_bad      bigint;
  bad_desc   text;
  actions    text;
BEGIN
  SELECT * INTO pre FROM _m0063_pre;

  -- G8. Coverage, BOTH directions. Forward: every non-null jsonb value produced a row. Backward:
  -- every row's slot set is exactly its derivation's key set, so nothing was invented. Plus the
  -- denormalisation the FK is about to enforce, checked here where a failure can name the row.
  SELECT count(*) INTO n_rows FROM derivation_sources;
  SELECT count(*) INTO n_expected
  FROM derivations d, LATERAL jsonb_object_keys(d.source_points) k(key)
  WHERE (d.source_points->>k.key) IS NOT NULL;
  IF n_rows <> n_expected THEN
    RAISE EXCEPTION '0063: derivation_sources has % row(s), expected % (one per non-null jsonb source) — the backfill did not cover its input', n_rows, n_expected;
  END IF;

  SELECT count(*), string_agg(format('%s: rows=%s keys=%s', id, rows_slots, json_slots), '; ')
  INTO n_bad, bad_desc
  FROM (
    SELECT d.id,
           (SELECT COALESCE(string_agg(ds.slot, ',' ORDER BY ds.slot), '')
              FROM derivation_sources ds WHERE ds.derivation_id = d.id) AS rows_slots,
           (SELECT COALESCE(string_agg(k.key, ',' ORDER BY k.key), '')
              FROM jsonb_object_keys(d.source_points) k(key)
             WHERE (d.source_points->>k.key) IS NOT NULL) AS json_slots
    FROM derivations d
  ) s
  WHERE rows_slots <> json_slots;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % derivation(s) have a slot set that differs from their jsonb key set — %', n_bad, bad_desc;
  END IF;

  SELECT count(*), string_agg(format('%s[%s]', derivation_id, slot), '; ')
  INTO n_bad, bad_desc
  FROM derivation_sources ds
  JOIN points p ON p.id = ds.point_id
  JOIN derivations d ON d.id = ds.derivation_id
  WHERE ds.device_id <> p.device_id
     OR ds.kind <> d.kind
     OR ds.role IS DISTINCT FROM d.role;
  IF n_bad > 0 THEN
    RAISE EXCEPTION '0063: % backfilled row(s) disagree with their parents on device_id/kind/role — %', n_bad, bad_desc;
  END IF;

  -- 🛑 G9. NOTHING WAS RECREATED. This is the migration's promise about the run history:
  -- `derived_intervals.derivation_id` is ON DELETE CASCADE, so a recreated derivations row is a
  -- silently emptied history. Counts AND the id digest, because equal counts prove nothing.
  IF (SELECT count(*) FROM derivations) <> pre.n_derivations THEN
    RAISE EXCEPTION '0063: derivations count is % but was % — rows were created or destroyed', (SELECT count(*) FROM derivations), pre.n_derivations;
  END IF;
  IF (SELECT md5(string_agg(id::text, ',' ORDER BY id)) FROM derivations) IS DISTINCT FROM pre.id_md5 THEN
    RAISE EXCEPTION '0063: the set of derivation ids CHANGED — a derivation was recreated, which CASCADE-deletes its stored intervals. This migration must never do that';
  END IF;
  IF (SELECT count(*) FROM derived_intervals) <> pre.n_intervals THEN
    RAISE EXCEPTION '0063: derived_intervals count is % but was % — run history was lost', (SELECT count(*) FROM derived_intervals), pre.n_intervals;
  END IF;

  -- G10. The catalog, BY NAME. A migration that silently did nothing looks exactly like one that
  -- worked, and a FK whose action quietly defaulted to NO ACTION is the specific failure that would
  -- break the sync's repoint-free `devices` leg while every row still looked right.
  SELECT string_agg(format('%s:%s/%s', conname, confupdtype::text, confdeltype::text), ' ' ORDER BY conname)
  INTO actions
  FROM pg_constraint
  WHERE contype = 'f'
    AND conrelid IN ('public.derivation_sources'::regclass, 'public.derivations'::regclass)
    AND conname IN ('derivation_sources_derivation_id_fk',
                    'derivation_sources_point_device_fk',
                    'derivation_sources_derivation_kind_role_fk',
                    'derivations_area_id_areas_id_fk');
  -- a = NO ACTION, c = CASCADE, n = SET NULL.
  IF actions IS DISTINCT FROM
     'derivation_sources_derivation_id_fk:a/c '
     || 'derivation_sources_derivation_kind_role_fk:c/c '
     || 'derivation_sources_point_device_fk:c/a '
     || 'derivations_area_id_areas_id_fk:a/n'
  THEN
    RAISE EXCEPTION '0063: FK actions are % — expected derivation_id a/c, kind_role c/c, point_device c/a, area_id a/n (update/delete; a=NO ACTION c=CASCADE n=SET NULL). A silently-NO-ACTION point_device UPDATE breaks prod-dev-sync''s devices leg', COALESCE(actions, 'NONE');
  END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.derivations'::regclass
                AND attname = 'area_id' AND attnotnull) THEN
    RAISE EXCEPTION '0063: derivations.area_id is still NOT NULL — ON DELETE SET NULL would abort the delete instead of clearing the reference';
  END IF;

  SELECT string_agg(relname, ' ' ORDER BY relname) INTO actions
  FROM pg_class
  WHERE relkind = 'i'
    AND relname IN ('points_id_device_unique','derivations_id_kind_role_unique',
                    'derivation_sources_device_idx','derivation_sources_point_idx',
                    'derivation_sources_signal_role_unique');
  IF actions IS DISTINCT FROM 'derivation_sources_device_idx derivation_sources_point_idx derivation_sources_signal_role_unique derivations_id_kind_role_unique points_id_device_unique' THEN
    RAISE EXCEPTION '0063: index set is % — expected all five', COALESCE(actions, 'NONE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.derivation_sources'::regclass
                    AND conname = 'derivation_sources_slot_check' AND contype = 'c') THEN
    RAISE EXCEPTION '0063: derivation_sources_slot_check was not created — a typo''d slot could still be stored';
  END IF;

  RAISE NOTICE '0063 OK: % source row(s) backfilled, % derivation(s) and % interval(s) untouched',
    n_rows, pre.n_derivations, pre.n_intervals;
END $$;
