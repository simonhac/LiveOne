-- 0053 config-v4 Phase 14 stage 17 — the last raw uuid leaves the wire.
--
-- Rewrites every helper device's `devices.vendor_site_id` from `helper:area:<raw areas.id uuid>` to
-- `helper:area:ar_<26-char TypeID>`. A DATA migration: no column, index, constraint or table changes,
-- nothing is dropped, and no `CASCADE` appears anywhere in this file.
--
-- ============================================================================================
-- WHY THIS IS A DATA MIGRATION AND NOT A WIRE CHANGE
--
-- `/api/data` emits `devices.vendor_site_id` verbatim as `DeviceBlock.vendorSiteId`
-- (lib/dashboard/serve-data.ts), and `/api/data` is **share-token readable** — so an ANONYMOUS
-- `?access=` viewer receives it. While a raw `areas.id` uuid sat inside that string it was the last
-- raw-uuid leak on the wire. The alternative fix was a second, `ar_`-shaped wire field alongside the
-- leaking one; Simon chose to fix the stored value instead (2026-07-31), so the leak has no
-- representation left rather than an unused replacement beside it.
--
-- The string is a device's VENDOR SITE IDENTITY, not an area reference the API resolves — the only
-- consumer that reads the area out of it is the `battery-provenance-history` card, client-side.
-- ============================================================================================
--
-- 🛑 DEPLOY THE CODE FIRST — the ADDITIVE rule, not the drop rule. This migration changes a value the
-- running build reads, so the build must already read BOTH forms before the data moves:
-- `parentAreaIdFromHelperSiteId` (lib/areas/helper-site-id.ts) is dual-accept as of this migration's
-- own PR, and `helperSiteId` mints the `ar_` form. Order:
--
--      1. MERGE the PR and let Vercel deploy it. Confirm `Ready` + aliased, `/api/health` 200.
--      2. Apply THIS migration to prod `sydney`.
--      3. Post-check the DATA (see below), not the migrator's exit line.
--      4. Apply to `liveone-dev` and re-post-check.
--      5. `npm run db:pg:generate` must report *No schema changes* (this file is hand-written and
--         diffs against nothing — it is invisible to drizzle-kit's schema diff by construction).
--
-- Applying it BEFORE the deploy is not catastrophic — it degrades to the card rendering nothing for a
-- helper device (`parentAreaIdFromHelperSiteId` returns null, the card returns null) — but there is no
-- reason to accept even that.
--
-- A helper minted in the window between step 1 and step 2 already carries the `ar_` form and is simply
-- not in this migration's input set. The post-condition still holds.
--
-- ⚠️ **The 2-hourly prod→dev sync will carry prod's values down to `liveone-dev` on its own.** The
-- `devices` leg is `mode: "full"`, so dev's rows are overwritten from prod wholesale. That is why
-- prod-first is not merely the house rule here but load-bearing: dev-first would be REVERTED by the
-- next sync, and would look like a failed migration.
--
-- No maintenance window, no queue pause. 6 rows on `liveone-dev` (measured 2026-07-31), a table of 18.
-- Helper devices are never polled and are off the hot ingest path.
--
-- 🛑 A MISSING MIGRATION FILE LOOKS IDENTICAL TO A SUCCESSFUL APPLY. `db:pg:migrate` run from a tree
-- lacking this file — or on a branch whose journal already names it — prints "migrations applied
-- successfully" and does nothing. Only the DATA distinguishes them:
--
--      SELECT count(*) FILTER (WHERE vendor_site_id ~ '^helper:area:[0-9a-fA-F-]{36}$')  AS raw_form,
--             count(*) FILTER (WHERE vendor_site_id ~ '^helper:area:ar_[0-9abcdefghjkmnpqrstvwxyz]{26}$') AS ar_form
--        FROM devices;
--
-- `raw_form` must be 0 and `ar_form` must equal the helper count. Related: `db:pg:migrate` swallows
-- `RAISE NOTICE`, so the inventory below is invisible in its output — capture it BY HAND first, or the
-- record is lost. Every GATE is a `RAISE EXCEPTION`, which is not swallowed.
--
-- ## Why the whole migration is ONE `DO` block
--
-- The payload is an UPDATE whose post-condition must be compared against a pre-condition measured in
-- the same breath. Splitting gates and payload into separate statements would mean re-deriving the
-- pre-counts after the write (impossible: the rows have changed) or smuggling them through a GUC. One
-- block shares the variables, and the whole thing is inside the migrator's transaction regardless, so
-- a failed assertion rolls the UPDATE back. Validation INSIDE the migration is the only check that
-- cannot be raced between probe and apply.
--
-- ## The TypeID encoding, in SQL — and how it is proven rather than hoped
--
-- A TypeID suffix is the 128-bit uuid rendered as 26 base-32 digits over the lowercase Crockford
-- alphabet (`lib/ids/base32.ts`), i.e. the big-endian bit string left-padded with two zero bits and cut
-- into 5-bit groups. Expressed here with Postgres bit-string primitives ONLY — `('x'||hex)::bit(128)`,
-- `substring(... for 5)`, `bit(32)::int` — so it is a positional base conversion, not a hand-rolled
-- byte shuffle, and it uses no `numeric ^` (whose result is not guaranteed exact).
--
-- It is verified THREE ways, because "the encoder is subtly wrong" is the only way this migration can
-- corrupt data:
--
--   1. **Offline, against `lib/ids` itself** — the identical expression was run over 20,136 vectors
--      (all 128 single-bit uuids, all-zero, all-ones, 10k uuidv7, 10k uuidv4) and compared to
--      `Area.encode`: **0 mismatches**, with a wrong-alphabet negative control confirmed to fail.
--   2. **G2, INSIDE this migration, against an oracle THIS DATABASE already holds** — `dashboards.doc`
--      stores `ar_` area refs written by `lib/ids` in production code. The encoder is applied to every
--      `areas.id` and must reproduce at least one of them exactly. A wrong encoder cannot accidentally
--      hit a real `lib/ids` output; if it produces zero hits the migration aborts before touching a row.
--   3. **G5, the output shape** — every rewritten value must match the strict `ar_` grammar, and the
--      distinct-value count must be preserved (an encoder that collapsed two areas onto one id aborts).
--
-- ## What this deliberately does NOT do
--
--   * **It does not touch `points`.** `points.id` is a deterministic uuidv5 over
--     `(vendor, vendor_site_id, physical_path)` (lib/identifiers/point-uid.ts), so the 24 existing
--     helper points were derived from the OLD site id. They keep their stored ids: `mintPoint`'s upsert
--     conflicts on `points_device_physical_path_unique` and RETURNS the existing row, so a re-mint is a
--     no-op, and nothing looks a point up by re-deriving its uid (`findPointByStemMetric` addresses by
--     `(rid, logical_path, metric_type)`). A genuinely NEW helper point minted after this lands gets a
--     uid derived from the new site id — still deterministic, just anchored to the new identity. That
--     is correct: a helper device is minted by us, never re-onboarded from a vendor, so the
--     "re-onboarding reproduces the same uid" property this derivation exists for does not apply.
--   * **It does not touch `updated_at`.** The value's MEANING is unchanged — same area, spelled the
--     way the rest of the system spells it — and the `devices` sync leg is `mode: "full"`, so no
--     watermark depends on it.
--   * **It does not deduplicate.** `liveone-dev` carries 6 helper rows over 4 distinct areas (two areas
--     have a second, point-less helper). That predates this change, `ensureHelperDevice` resolves it by
--     lowest `rid`, and rewriting is row-wise so duplicates simply stay duplicated.
--
-- Not idempotent, and deliberately not: G3 turns a second run into an explicit failure rather than a
-- confusing no-op. The journal is what prevents a second run.

DO $$
DECLARE
  col_attnum        smallint;
  n_devices         bigint;
  n_helper_prefixed bigint;
  n_raw             bigint;
  n_ar              bigint;
  n_unrecognised    bigint;
  n_bad_uuid        bigint;
  n_unique_idx      bigint;
  n_doc_refs        bigint;
  n_oracle_hits     bigint;
  n_enc             bigint;
  n_enc_distinct    bigint;
  n_bad_shape       bigint;
  n_updated         bigint;
  n_raw_after       bigint;
  n_ar_after        bigint;
BEGIN
  -- ── G0. The catalog says this migration is being applied to the state it was written against. ──
  SELECT attnum INTO col_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.devices'::regclass AND attname = 'vendor_site_id' AND NOT attisdropped;

  IF col_attnum IS NULL THEN
    RAISE EXCEPTION '0053: devices.vendor_site_id does not exist — this is not the schema this migration was written against';
  END IF;

  SELECT count(*) INTO n_devices FROM devices;
  IF n_devices = 0 THEN
    RAISE EXCEPTION '0053: devices is EMPTY — this is not a database anything has been served from; refusing to run blind';
  END IF;

  -- ── G1. The value being rewritten must not be a KEY. ────────────────────────────────────────
  -- Rewriting a column something joins on, or that is unique, is a different and much larger change.
  -- Measured: `devices` has exactly two unique indexes (`devices_rid_unique`, `devices_owner_slug_unique`)
  -- and neither names this column; the old `systems_vendor_site_id_idx` (0020) was a plain btree and
  -- died with `systems` in 0051. Unique CONSTRAINTS are index-backed, so this one lookup covers them too.
  SELECT count(*) INTO n_unique_idx
  FROM pg_index i
  WHERE i.indrelid = 'public.devices'::regclass
    AND i.indisunique
    AND col_attnum = ANY (i.indkey);

  IF n_unique_idx <> 0 THEN
    RAISE EXCEPTION '0053: % unique index(es)/constraint(s) on devices cover vendor_site_id — it is a KEY, and rewriting a key is not this migration; stop and re-plan',
      n_unique_idx;
  END IF;

  -- ── G3 (inventory). Every `helper:area:` row must be in one of the two KNOWN forms. ─────────
  -- The raw pattern is the LOOSE one the retired TS regex used (36 hex/dash chars), so the input set is
  -- exactly what the old code recognised — not a stricter set that would silently leave rows behind.
  SELECT
    count(*) FILTER (WHERE vendor_site_id LIKE 'helper:area:%'),
    count(*) FILTER (WHERE vendor_site_id ~ '^helper:area:[0-9a-fA-F-]{36}$'),
    count(*) FILTER (WHERE vendor_site_id ~ '^helper:area:ar_[0-9abcdefghjkmnpqrstvwxyz]{26}$')
  INTO n_helper_prefixed, n_raw, n_ar
  FROM devices;

  n_unrecognised := n_helper_prefixed - n_raw - n_ar;
  IF n_unrecognised <> 0 THEN
    RAISE EXCEPTION '0053: % device(s) carry a helper:area: vendor_site_id in NEITHER the raw-uuid nor the ar_ form — an unrecognised shape must be understood, not skipped',
      n_unrecognised;
  END IF;

  IF n_raw = 0 THEN
    RAISE EXCEPTION '0053: no helper device carries the raw-uuid vendor_site_id form (ar_ form: %, helper-prefixed: %) — either this migration is ALREADY APPLIED to this branch, or this database has no helper devices at all. Reconcile by hand rather than recording a no-op as applied',
      n_ar, n_helper_prefixed;
  END IF;

  -- Loose-but-not-canonical: 36 chars of hex/dash that are not a uuid. `::uuid` would raise 22P02 with
  -- an opaque message, so catch it here with a legible one.
  SELECT count(*) INTO n_bad_uuid
  FROM devices
  WHERE vendor_site_id ~ '^helper:area:[0-9a-fA-F-]{36}$'
    AND vendor_site_id !~ '^helper:area:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

  IF n_bad_uuid <> 0 THEN
    RAISE EXCEPTION '0053: % helper vendor_site_id(s) hold 36 chars that are not a canonical uuid — there is no area id to encode; inspect them by hand',
      n_bad_uuid;
  END IF;

  RAISE NOTICE '0053 inventory: % devices; % helper-prefixed = % raw-uuid + % ar_', n_devices, n_helper_prefixed, n_raw, n_ar;

  -- ── The encoding. ONE instance of the expression, over BOTH the rows to rewrite and the oracle. ──
  -- 128-bit uuid -> 26 base-32 digits: prepend two zero bits, cut into 5-bit groups big-endian, index
  -- the lowercase Crockford alphabet. `('x'||hex)::bit(128)` is the hex->bits primitive; `bit(32)::int`
  -- turns each padded group into its digit value. Exact integer arithmetic throughout.
  CREATE TEMP TABLE p14_0053_enc ON COMMIT DROP AS
  SELECT
    s.src,
    s.key,
    s.u,
    'ar_' || (
      SELECT string_agg(
        substr('0123456789abcdefghjkmnpqrstvwxyz',
               1 + ((B'000000000000000000000000000' ||
                     substring(B'00' || ('x' || replace(s.u::text, '-', ''))::bit(128)
                               from 5 * i + 1 for 5)
                    )::bit(32)::int),
               1),
        '' ORDER BY i)
      FROM generate_series(0, 25) AS i
    ) AS ar_id
  FROM (
    -- the rows to rewrite
    SELECT 'device'::text AS src, d.id::text AS key,
           lower(substring(d.vendor_site_id from 13))::uuid AS u
      FROM devices d
     WHERE d.vendor_site_id ~ '^helper:area:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    UNION ALL
    -- the oracle domain
    SELECT 'area'::text, a.id::text, a.id
      FROM areas a
  ) s;

  -- ── G2. THE ORACLE. Prove the encoder above reproduces `lib/ids` — on THIS database, at apply time. ──
  -- `dashboards.doc` holds `ar_` area refs written by application code through `lib/ids`. They are an
  -- independent, in-database expected-value table for the encoder. A wrong encoder cannot accidentally
  -- reproduce one, so a single hit is proof of the alphabet AND the bit packing.
  SELECT count(*) INTO n_doc_refs
  FROM (SELECT DISTINCT (regexp_matches(doc::text, 'ar_[0-9abcdefghjkmnpqrstvwxyz]{26}', 'g'))[1] AS ref
          FROM dashboards) t;

  IF n_doc_refs = 0 THEN
    RAISE EXCEPTION '0053: no ar_ area ref found in dashboards.doc — the in-database oracle for the TypeID encoder is UNAVAILABLE on this branch, so the encoder cannot be verified here; refusing to rewrite identities on an unverified encoder';
  END IF;

  SELECT count(*) INTO n_oracle_hits
  FROM (SELECT DISTINCT (regexp_matches(doc::text, 'ar_[0-9abcdefghjkmnpqrstvwxyz]{26}', 'g'))[1] AS ref
          FROM dashboards) t
  WHERE EXISTS (SELECT 1 FROM p14_0053_enc e WHERE e.src = 'area' AND e.ar_id = t.ref);

  IF n_oracle_hits = 0 THEN
    RAISE EXCEPTION '0053: the SQL TypeID encoder reproduced NONE of the % ar_ refs stored in dashboards.doc — it disagrees with lib/ids. Nothing has been rewritten',
      n_doc_refs;
  END IF;

  -- Misses are NOT gated: a doc may reference an area that has since been deleted, which is a dangling
  -- ref rather than an encoder fault. Hits >= 1 is the proof; the count is reported for the record.
  RAISE NOTICE '0053 G2 oracle: % of % distinct dashboards.doc ar_ refs reproduced by the SQL encoder', n_oracle_hits, n_doc_refs;

  -- ── G4. The computed set covers exactly the rows to rewrite, and its output is well-formed. ──
  SELECT count(*), count(DISTINCT ar_id) INTO n_enc, n_enc_distinct
  FROM p14_0053_enc WHERE src = 'device';

  IF n_enc <> n_raw THEN
    RAISE EXCEPTION '0053: encoded % row(s) but % carry the raw form — the strict and loose patterns disagree, which G3 should have made impossible',
      n_enc, n_raw;
  END IF;

  IF n_enc_distinct <> (SELECT count(DISTINCT u) FROM p14_0053_enc WHERE src = 'device') THEN
    RAISE EXCEPTION '0053: the encoder mapped distinct area uuids onto the SAME ar_ id — it is not injective and is therefore wrong';
  END IF;

  SELECT count(*) INTO n_bad_shape
  FROM p14_0053_enc
  WHERE src = 'device' AND ar_id !~ '^ar_[0-9abcdefghjkmnpqrstvwxyz]{26}$';

  IF n_bad_shape <> 0 THEN
    RAISE EXCEPTION '0053: % encoded value(s) are not a well-formed ar_ TypeID', n_bad_shape;
  END IF;

  -- ── The payload. ────────────────────────────────────────────────────────────────────────────
  UPDATE devices d
     SET vendor_site_id = 'helper:area:' || e.ar_id
    FROM p14_0053_enc e
   WHERE e.src = 'device' AND e.key = d.id::text;

  GET DIAGNOSTICS n_updated = ROW_COUNT;

  IF n_updated <> n_raw THEN
    RAISE EXCEPTION '0053: updated % row(s), expected % — aborting',
      n_updated, n_raw;
  END IF;

  -- ── G5. Post-state, asserted rather than assumed. ───────────────────────────────────────────
  SELECT
    count(*) FILTER (WHERE vendor_site_id ~ '^helper:area:[0-9a-fA-F-]{36}$'),
    count(*) FILTER (WHERE vendor_site_id ~ '^helper:area:ar_[0-9abcdefghjkmnpqrstvwxyz]{26}$'),
    count(*) FILTER (WHERE vendor_site_id LIKE 'helper:area:%')
  INTO n_raw_after, n_ar_after, n_helper_prefixed
  FROM devices;

  IF n_raw_after <> 0 THEN
    RAISE EXCEPTION '0053: % helper vendor_site_id(s) still carry a raw uuid after the rewrite — the leak is not closed',
      n_raw_after;
  END IF;

  IF n_ar_after <> n_ar + n_raw THEN
    RAISE EXCEPTION '0053: ar_-form helper rows = % after the rewrite, expected % (% already migrated + % rewritten) — rows were lost or gained',
      n_ar_after, n_ar + n_raw, n_ar, n_raw;
  END IF;

  IF n_helper_prefixed <> n_ar_after THEN
    RAISE EXCEPTION '0053: % helper-prefixed row(s) but only % in ar_ form — a row was left in an unrecognised shape',
      n_helper_prefixed, n_ar_after;
  END IF;

  IF (SELECT count(*) FROM devices) <> n_devices THEN
    RAISE EXCEPTION '0053: the devices row count changed during the migration (% -> %)',
      n_devices, (SELECT count(*) FROM devices);
  END IF;

  RAISE NOTICE '0053 OK: % row(s) rewritten to helper:area:ar_…; raw-uuid form now 0 of % helper rows', n_updated, n_ar_after;
END $$;
