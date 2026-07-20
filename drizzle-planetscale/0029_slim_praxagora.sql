-- Retire the legacy energy-only Sankey matrix `point_readings_flow_1d`. Its data is superseded by
-- `point_readings_flow_attr_1d` (same edges + energy, plus the attributed emissions/renewable/cost
-- legs), which is now the SOLE flow/Sankey matrix (readers + the daily writer were repointed).
--
-- APPLY ORDER (PG migrations are manual — CLAUDE.md): deploy the code FIRST and let the unified daily
-- heal materialise `flow_attr_1d` for EVERY complete logical system (battery AND battery-less), confirm
-- coverage, THEN apply this. The guards below are backstops for a mis-ordered apply, not a substitute
-- for that sequence.
--
-- Guard 1: refuse if the replacement matrix is empty (never materialised).
-- Guard 2: refuse if `flow_attr_1d` is only PARTIALLY materialised for an area it otherwise covers — a
-- (area, day) present in `flow_1d` but missing from `flow_attr_1d` for the SAME area. Day-level, so it
-- tolerates the known solar-leaf granularity difference (per-edge source sets may legitimately differ;
-- per-day coverage must not). Both flow tables are small, so the anti-join is instant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM point_readings_flow_attr_1d) THEN
    RAISE EXCEPTION 'Refusing to DROP point_readings_flow_1d: replacement point_readings_flow_attr_1d is empty (no rows). Materialise flow_attr_1d first.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (SELECT DISTINCT area_id, day FROM point_readings_flow_1d) f
    WHERE f.area_id IN (SELECT area_id FROM point_readings_flow_attr_1d GROUP BY area_id)
      AND NOT EXISTS (
        SELECT 1 FROM point_readings_flow_attr_1d m
        WHERE m.area_id = f.area_id AND m.day = f.day
      )
  ) THEN
    RAISE EXCEPTION 'Refusing to DROP point_readings_flow_1d: point_readings_flow_attr_1d is only PARTIALLY materialised (an (area, day) in flow_1d is missing from flow_attr_1d for an area flow_attr already covers). Backfill flow_attr_1d fully first.';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "point_readings_flow_1d";
