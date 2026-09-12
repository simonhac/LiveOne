/**
 * The microsecond guard.
 *
 * `claimExerciseDispatch` is a compare-and-set on `automations.updated_at`, a
 * `timestamp(6) DEFAULT now()` column. For two days it matched NOTHING — every tick "lost" a claim
 * nobody held, `fireExercise` returned silently, and two live generator-exercise rules never fired
 * once, with no log line anywhere. The reason was entirely inside the driver's type codec, which is
 * what this file pins.
 *
 * `evaluate.test.ts` cannot cover this: it mocks `@/lib/automations/store` wholesale, which is right
 * for testing the evaluator but means nothing there ever runs the SQL. The end-to-end companion is
 * `store.integration.test.ts`, which executes the claim against a real Postgres.
 */
import { describe, expect, it } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import { automations } from "@/lib/db/planetscale/schema";
import { exerciseClaimWhere } from "@/lib/automations/store";

const UUID = "f2b1c4d6-0000-4000-8000-000000000001";

describe("the timestamp round trip that broke the claim", () => {
  it("🛑 TRUNCATES microseconds on the way in — a DEFAULT now() value cannot be echoed back", () => {
    const parsed = automations.updatedAt.mapFromDriverValue(
      "2026-09-01 10:41:43.616884",
    ) as Date;
    // Not .617 — V8 truncates rather than rounds, which is why the SQL side truncates too.
    expect(parsed.toISOString()).toBe("2026-09-01T10:41:43.616Z");
    expect(automations.updatedAt.mapToDriverValue(parsed)).toBe(
      "2026-09-01T10:41:43.616Z",
    );
  });

  it("rounds nothing: .616984 also lands on .616", () => {
    const parsed = automations.updatedAt.mapFromDriverValue(
      "2026-09-01 10:41:43.616984",
    ) as Date;
    expect(parsed.toISOString()).toBe("2026-09-01T10:41:43.616Z");
  });
});

describe("exerciseClaimWhere", () => {
  const query = (at: Date) =>
    new PgDialect().sqlToQuery(exerciseClaimWhere(UUID, at)!);

  it("🛑 compares at millisecond resolution, not raw equality", () => {
    const { sql } = query(new Date("2026-09-01T10:41:43.616Z"));
    expect(sql).toContain("date_trunc('milliseconds'");
  });

  it("🛑 binds the instant through the column's UTC encoder, not as a raw Date", () => {
    // A raw Date would be serialised by node-postgres in the PROCESS's local zone; Postgres then
    // drops the offset coercing to `timestamp without time zone`, and the predicate is silently
    // wrong by that offset. A string here is the proof `sql.param` did the encoding.
    const { params } = query(new Date("2026-09-01T10:41:43.616Z"));
    expect(params).toContain("2026-09-01T10:41:43.616Z");
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it("still narrows to the one row", () => {
    const { params } = query(new Date("2026-09-01T10:41:43.616Z"));
    expect(params).toContain(UUID);
  });
});
