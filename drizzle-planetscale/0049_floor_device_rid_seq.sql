-- 0049 config-v4 Phase 12 (pre-terminal prep): re-floor device_rid_seq above every device rid that
-- exists today, so the terminal window's first device create cannot collide on devices_rid_unique.
--
-- Hand-authored (a setval cannot be expressed in the schema model, so `db:pg:generate --custom`
-- produced the journal entry + snapshot and this body was written by hand). It creates NO objects and
-- alters NO catalog: `device_rid_seq` exists since 0035 and is already postgres-owned, so a temp
-- `pscale role` needs only `pscale role delete` afterward — no `reassign`.
--
-- ## Why this exists, stated accurately
--
-- 0043 already floored this sequence, with the same three-way greatest() used below, and both
-- environments carry that value (dev: last_value = max(devices.rid) = max(systems.id) = 10003). So the
-- sequence is NOT stuck at 1 and the DEFAULT is not unfloored. What 0043 could not do is STAY floored:
-- `devices.rid` is minted verbatim as `systems.id` (`ensureDeviceRow`, lib/registry/v4-mirror.ts) out of
-- `systems_id_seq`, which advances entirely independently of `device_rid_seq`. Every device created since
-- 0043 pushed max(devices.rid) up while device_rid_seq stood still. 0043's floor is a POINT-IN-TIME floor
-- and drifts by design.
--
-- The terminal window (slices I+J+L+N) makes `devices` the write target, and its own migration re-asserts
-- this setval as its last statement. That is sufficient, but it is the SINGLE line of defence, executed
-- inside the one irreversible migration, under a paused QStash queue. Running the floor NOW as an
-- independent, additive, prod-safe statement demotes the terminal one to a re-assert: any drift
-- accumulated since 0043 is corrected here, in a migration whose worst case is "did nothing".
--
-- ## Why this is safe to apply while `systems` still exists
--
-- Raising a sequence's floor cannot lower anything and cannot invalidate an existing row. The DEFAULT on
-- `devices.rid` stays inert (nothing mints a device from it while `ensureDeviceRow` names `s.id`), so this
-- changes no observable behaviour today. It is purely additive, so it goes to prod BEFORE the terminal
-- deploy — and it must, because the terminal build is the first thing that can consume the sequence.
--
-- ## setval is NOT transactional (the 0043 lesson)
--
-- Postgres sequence changes are not rolled back by an aborted transaction. So a setval stranded by a
-- failed run must be a harmless no-op on the next run — which a `greatest(…, last_value)` FLOOR is by
-- construction: it can only move the sequence forward, never back, and re-running it against an
-- already-floored sequence writes the value it already holds. The guard therefore runs FIRST, before the
-- setval, so a refusal leaves the database untouched; and the setval is the ONLY mutation here, so there
-- is nothing for a stranded one to be inconsistent with.
--
-- Idempotent by construction. Nothing is dropped, so there is no CASCADE to withhold. Re-running is a
-- no-op.
--
-- ⚠️ `db:pg:migrate` swallows RAISE NOTICE, so the pre/post values are not in the migrate output.
-- Capture them by hand, before and after:
--   select last_value, is_called from device_rid_seq;
--   select count(*), max(rid) from devices;  select max(id) from systems;

-- Guard first, before the (non-transactional) setval, so a refusal leaves the DB untouched.
--
-- 1. `devices` is non-empty. An empty `devices` would mean the registry copy never happened or has been
--    truncated; flooring off max(NULL) would silently degrade to "leave the sequence alone" and hide
--    that, so refuse rather than no-op.
-- 2. max(devices.rid) is sane — positive, and below the >= 1,000,000 area-handle band
--    (`AREA_HANDLE_BASE`, lib/areas/handles.ts). A device rid inside that band would mean the two
--    allocators have already collided; flooring the DEVICE sequence past an AREA handle would then hand
--    out device rids that shadow area handles for as long as `legacy_handles` resolves both. That is a
--    pre-existing corruption to diagnose, not to cement.
-- 3. The seam invariant `devices.rid == systems.id` holds in the direction that matters here: every
--    `systems.id` has a matching `devices.rid`. If it does not, then max(systems.id) is a handle no
--    device row claims, the terminal window's G2 identity proof would fail anyway, and flooring past it
--    would mask which table is short. (The REVERSE direction — a `devices` row with no `systems` row —
--    is DELIBERATE and must NOT be asserted: `deleteSystem` leaves exactly that orphan, and the terminal
--    window's FK-coverage guard depends on it.)
DO $$
DECLARE
  n_devices    bigint;
  max_device   bigint;
  n_unmirrored bigint;
BEGIN
  SELECT count(*), coalesce(max(rid), 0) INTO n_devices, max_device FROM devices;

  IF n_devices = 0 THEN
    RAISE EXCEPTION 'refusing to floor device_rid_seq: devices is empty, expected the populated v4 registry: %',
      n_devices;
  END IF;

  IF max_device <= 0 OR max_device >= 1000000 THEN
    RAISE EXCEPTION 'refusing to floor device_rid_seq: max(devices.rid) is outside the sane device band (1 .. 999999; >= 1000000 is the area-handle band): %',
      max_device;
  END IF;

  SELECT count(*) INTO n_unmirrored
  FROM systems s
  LEFT JOIN devices d ON d.rid = s.id
  WHERE d.rid IS NULL;

  IF n_unmirrored <> 0 THEN
    RAISE EXCEPTION 'refusing to floor device_rid_seq: systems rows with no matching devices.rid — the devices.rid == systems.id seam is broken; fix that before moving the sequence: %',
      n_unmirrored;
  END IF;

  RAISE NOTICE '0049 pre-check OK: % devices, max(devices.rid) = %, unmirrored systems = %',
    n_devices, max_device, n_unmirrored;
END $$;
--> statement-breakpoint
-- The floor. Three-way greatest(), the same shape 0043 used and for the same three reasons:
--   * max(systems.id)  — systems_id_seq is the live allocator and `devices.rid` copies it verbatim, so a
--                        handle already issued there must never be issued again from here.
--   * max(devices.rid) — the rids that actually exist. Equal to the above today (guard 3), but asserted
--                        independently so this statement is correct on its own terms.
--   * last_value       — a re-run must never move the sequence BACKWARDS. This is what makes a stranded,
--                        non-transactional setval a no-op.
-- is_called = true → the next nextval() returns floor + 1, i.e. the first free rid.
SELECT setval(
  'device_rid_seq',
  greatest(
    (SELECT coalesce(max(id), 0) FROM systems),
    (SELECT coalesce(max(rid), 0) FROM devices),
    (SELECT last_value FROM device_rid_seq)
  ),
  true
);
