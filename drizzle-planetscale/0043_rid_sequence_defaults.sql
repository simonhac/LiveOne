-- 0043 config-v4 Phase 12 (slice B): attach nextval DEFAULTs to devices.rid and points.rid.
-- Hand-authored (drizzle emitted only the two bare ALTER … SET DEFAULT lines): the setval that makes
-- the device default collision-free, and the guard that proves the point default is, cannot be
-- expressed in the schema model. meta/0043_snapshot.json is kept machine-written so future
-- db:pg:generate diffs clean. Applied in a single transaction, so an abort rolls back both ALTERs —
-- but NOT the setval: sequence changes are non-transactional in Postgres. That is why the guard runs
-- first, before any mutation, and why the setval is written to be monotonic (a stranded setval from a
-- failed run is a no-op on the next).
--
-- Both sequences already exist (point_rid_seq from 0030, device_rid_seq from 0035), so this creates
-- NO objects. OWNERSHIP: nothing to reassign — a temp `pscale role` needs only `pscale role delete`
-- afterward. (The app calls nextval() as `postgres`; both sequences are already postgres-owned, and
-- neither is column-owned — see the 0030 header for why.)
--
-- Idempotent: re-running re-asserts the same DEFAULTs and a monotonic setval.
--
-- ⚠️ Both DEFAULTs are INERT scaffolding today; nothing may rely on them yet.
--   * devices.rid — while `systems` still exists, systems_id_seq advances independently of
--     device_rid_seq, so a device minted from this DEFAULT could later collide with a new systems.id
--     on devices_rid_unique. ensureDeviceRow (lib/registry/v4-mirror.ts) must keep naming rid as
--     `s.id` verbatim. Slice N drops `systems` and re-asserts the setval; only then is it live.
--   * points.rid — must stay equal to point_info.rid (lib/registry/v4-mirror.ts:24-25), which is why
--     it shares point_rid_seq rather than getting its own. mirrorPoint still passes the rid that
--     point_info's own DEFAULT returned; slice M is what flips it.

-- Guard first, before any mutation, so an abort leaves the DB untouched. point_rid_seq is already
-- floored at max(point_info.rid) by 0030 and advanced by every insert since; points.rid mirrors
-- point_info.rid, so it cannot exceed that — but assert it rather than assume, because attaching the
-- DEFAULT below a stale sequence would hand out a duplicate rid on first use.
DO $$
BEGIN
  IF (SELECT coalesce(max(rid), 0) FROM points) > (SELECT last_value FROM point_rid_seq) THEN
    RAISE EXCEPTION 'Refusing 0043: max(points.rid) = % exceeds point_rid_seq.last_value = % — setval point_rid_seq to at least max(point_info.rid) first',
      (SELECT max(rid) FROM points), (SELECT last_value FROM point_rid_seq);
  END IF;
END $$;
--> statement-breakpoint
-- Floor device_rid_seq above every rid that exists or could be minted from systems_id_seq. The
-- three-way greatest() matters: registry-populate seeded this from max(devices.rid), but
-- systems_id_seq keeps advancing on its own, and a re-run must never move the sequence backwards.
-- is_called = true → the next nextval returns floor + 1.
SELECT setval(
  'device_rid_seq',
  greatest(
    (SELECT coalesce(max(id), 0) FROM systems),
    (SELECT coalesce(max(rid), 0) FROM devices),
    (SELECT last_value FROM device_rid_seq)
  ),
  true
);
--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "rid" SET DEFAULT nextval('device_rid_seq');
--> statement-breakpoint
ALTER TABLE "points" ALTER COLUMN "rid" SET DEFAULT nextval('point_rid_seq');
