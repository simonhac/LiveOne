import { describe, it, expect } from "@jest/globals";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../schema";

/**
 * The house-type gate: every timestamp column is `timestamp(3)`.
 *
 * A bare `timestamp()` is `timestamp(6)`, which can hold a value no JS `Date` can represent. With a
 * `DEFAULT now()` it produces one on EVERY insert, and drizzle's codec then truncates it on the way
 * out (`new Date(…)`) and writes it back as `toISOString()` — so `where(eq(col, rowFromTheDb.col))`
 * compares `…43.616884` against `…43.616` and matches nothing, silently. That is #468: two
 * generator-exercise automations that never fired, with no error anywhere. Migration 0064 narrowed
 * the columns; this test is what stops the next one being declared wide.
 *
 * Pure drizzle introspection — no DB connection. It fails on a NEW bare `timestamp()` the moment it
 * is written, which is the only defence that does not rely on remembering.
 */

/** `table.column` for the nine columns deliberately left at `timestamp(6)`. */
const WIDE_BY_DESIGN = new Set([
  // Narrowing a column's type is a FULL TABLE REWRITE under ACCESS EXCLUSIVE, and drizzle runs a
  // whole migration in ONE transaction — so a slow rewrite holds its lock, and every lock taken
  // before it, until the last statement commits. These four tables are the ones where that cost is
  // real AND the ingest path writes them every minute: point_readings (15.4M rows / 2.5 GB),
  // point_readings_agg_5m (7.6M / 1.7 GB), sessions (1.3M / 1.4 GB), observations_outbox (601 MB on
  // prod — measured; the rewrite rate on this infrastructure is ~28 MB/s, so ~21 s of ACCESS
  // EXCLUSIVE on the ingest tee alone).
  //
  // What makes that safe is NOT "nothing reads them" — they are read, for freshness probes,
  // ingestion health and the prod→dev sync watermarks. It is that none of them is compared for
  // EQUALITY against a value that round-tripped through JS: the key columns (`measurement_time`,
  // `received_time`, `interval_end`) have no DB-side default and every writer passes a JS `Date`,
  // so they already hold whole milliseconds; the `now()`-defaulted stamps are only read with range
  // comparisons.
  //
  // 🛑 Adding an entry here is a decision, not a formality: it means a column that a JS `Date`
  // cannot round-trip. If it will ever be compared for equality — or leased, claimed or CAS'd on —
  // narrow it instead, in a migration of its own so the lock is not bundled with anything else.
  "point_readings.measurement_time",
  "point_readings.received_time",
  "point_readings.created_at",
  "point_readings_agg_5m.interval_end",
  "point_readings_agg_5m.created_at",
  "point_readings_agg_5m.updated_at",
  "sessions.created_at",
  "observations_outbox.created_at",
  "observations_outbox.published_at",
]);

type TimestampColumn = { qualified: string; sqlType: string };

function timestampColumns(): TimestampColumn[] {
  const out: TimestampColumn[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const { name, columns } = getTableConfig(value);
    for (const column of columns) {
      const sqlType = column.getSQLType();
      if (!sqlType.startsWith("timestamp")) continue;
      out.push({ qualified: `${name}.${column.name}`, sqlType });
    }
  }
  return out;
}

describe("timestamp precision across the whole schema", () => {
  const columns = timestampColumns();

  it("finds the timestamp columns at all (a silent empty walk would pass everything)", () => {
    expect(columns.length).toBeGreaterThan(40);
  });

  it("🛑 declares every timestamp column as timestamp(3) — see `tsMs` in schema.ts", () => {
    const wide = columns
      .filter((c) => !WIDE_BY_DESIGN.has(c.qualified))
      .filter((c) => c.sqlType !== "timestamp (3)")
      .map((c) => `${c.qualified} is ${c.sqlType}`);
    // A bare `timestamp()` renders as "timestamp" — declare it with `tsMs(…)` instead, and ship the
    // matching `ALTER COLUMN … SET DATA TYPE timestamp(3)` migration with it.
    expect(wide).toEqual([]);
  });

  it("keeps the exception list honest — every entry still exists and is still wide", () => {
    const stillWide = new Set(
      columns.filter((c) => c.sqlType === "timestamp").map((c) => c.qualified),
    );
    // A stale entry here would silently exempt nothing — or worse, a column that later got narrowed,
    // leaving the list reading as though microseconds were still in play somewhere they are not.
    expect([...WIDE_BY_DESIGN].filter((q) => !stillWide.has(q))).toEqual([]);
  });
});

describe("automations.revision", () => {
  it("🛑 is the CAS token: an integer, NOT NULL, defaulted so old rows start at 1", () => {
    const column = getTableConfig(schema.automations).columns.find(
      (c) => c.name === "revision",
    );
    expect(column?.getSQLType()).toBe("integer");
    expect(column?.notNull).toBe(true);
    // The value matters, not just the presence: rows that predate migration 0064 are backfilled with
    // it, and `claimExerciseDispatch` compares against whatever `create()` left behind.
    expect(column?.default).toBe(1);
  });
});
