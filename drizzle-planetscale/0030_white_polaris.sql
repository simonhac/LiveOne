-- 0030 config-v4 Phase 2 (B2 + B3): harden point identity — point_uid NOT NULL + global rid sequence.
-- Hand-authored (replaces drizzle's generated ADD COLUMN/SET NOT NULL): drizzle cannot express a
-- CREATE SEQUENCE, a deterministic ordered backfill, the nextval DEFAULT, or ALTER SEQUENCE ... OWNED
-- BY. meta/0030_snapshot.json is kept as machine-written so future db:pg:generate diffs clean.
-- Applied in a single transaction (all statements are transactional DDL) — any guard abort rolls the
-- whole migration back. Additive: the (system_id, id) address and all six composite FKs are untouched.
-- Apply as the persistent `postgres` role: the new point_rid_seq + pi_rid_unique must be postgres-owned
-- or the app's per-insert nextval() gets "permission denied for sequence" (see CLAUDE.md ownership trap).

-- B2 guard: refuse if any point_uid is still NULL. Runs first, so the table is untouched on abort.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_info WHERE point_uid IS NULL) THEN
    RAISE EXCEPTION 'Refusing 0030: % point_info row(s) still have NULL point_uid — run backfill-point-uid.ts --commit first',
      (SELECT count(*) FROM point_info WHERE point_uid IS NULL);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "point_info" ALTER COLUMN "point_uid" SET NOT NULL;
--> statement-breakpoint
CREATE SEQUENCE "point_rid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
ALTER TABLE "point_info" ADD COLUMN "rid" integer;   -- nullable first (no default yet)
--> statement-breakpoint
-- Deterministic backfill: row_number() over (system_id, id) fully specifies the rid mapping regardless
-- of physical/execution order. `SET rid = nextval(...)` would NOT: an UPDATE has no ORDER BY and
-- nextval's per-row eval order is unspecified, giving unique-but-unordered rids. ("id" is the DB
-- column for the TS field `index`.)
WITH ordered AS (
  SELECT system_id, id, row_number() OVER (ORDER BY system_id, id) AS rn FROM point_info
)
UPDATE point_info p SET rid = o.rn FROM ordered o
WHERE p.system_id = o.system_id AND p.id = o.id;
--> statement-breakpoint
-- Advance the sequence past the backfilled max (is_called defaults true → next nextval = max+1).
-- point_info is non-empty (every row was just ranked), so max(rid) >= 1.
SELECT setval('point_rid_seq', (SELECT max(rid) FROM point_info));
--> statement-breakpoint
-- From here new rows auto-allocate rid from the sequence (kills any max()+1 race for the hot key).
ALTER TABLE "point_info" ALTER COLUMN "rid" SET DEFAULT nextval('point_rid_seq');
--> statement-breakpoint
-- Post-backfill guard: prove full coverage before enforcing NOT NULL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM point_info WHERE rid IS NULL) THEN
    RAISE EXCEPTION 'Refusing 0030: % point_info row(s) have NULL rid after backfill',
      (SELECT count(*) FROM point_info WHERE rid IS NULL);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "point_info" ALTER COLUMN "rid" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "pi_rid_unique" ON "point_info" USING btree ("rid");
--> statement-breakpoint
-- Tie the sequence lifecycle to the column (auto-dropped with it). Requires ownership of BOTH objects.
ALTER SEQUENCE "point_rid_seq" OWNED BY "point_info"."rid";
