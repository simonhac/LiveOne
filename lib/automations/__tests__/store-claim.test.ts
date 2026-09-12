/**
 * The claim's key, and the round trip that made the old one wrong.
 *
 * `claimExerciseDispatch` used to be a compare-and-set on `automations.updated_at`, a
 * `timestamp(6) DEFAULT now()` column. For two days it matched NOTHING — every tick "lost" a claim
 * nobody held, `fireExercise` returned silently, and two live generator-exercise rules never fired
 * once, with no log line anywhere. The reason was entirely inside the driver's type codec.
 *
 * Two things came out of that, and this file pins both: the CAS key is now the integer `revision`
 * (#468 follow-up), and the codec behaviour that broke the timestamp version is asserted here so it
 * stays a known property rather than a surprise the next time someone reaches for a `Date`.
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
  it("🛑 TRUNCATES sub-millisecond digits on the way in — a timestamp(6) cannot be echoed back", () => {
    // The column is `timestamp(3)` since migration 0064, so Postgres no longer HANDS us a value like
    // this. The codec that mangled it is unchanged though: this is why no `timestamp` column may be
    // declared wide (see `lib/db/planetscale/__tests__/schema-shape.test.ts`) and why the CAS below
    // is keyed on an integer.
    const parsed = automations.updatedAt.mapFromDriverValue(
      "2026-09-01 10:41:43.616884",
    ) as Date;
    // Not .617 — V8 truncates rather than rounds. Postgres, coercing to timestamp(3), ROUNDS. Two
    // disagreeing rules is exactly the kind of thing an equality must not be built on.
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
  const query = (revision: number) =>
    new PgDialect().sqlToQuery(exerciseClaimWhere(UUID, revision)!);

  it("🛑 keys the compare-and-set on `revision`, never on a timestamp", () => {
    const { sql, params } = query(7);
    expect(sql).toContain('"revision" = $');
    expect(sql).not.toContain("updated_at");
    expect(params).toContain(7);
    // A `Date` anywhere in the parameters means the CAS went back to comparing time, which node-
    // postgres would serialise in the PROCESS's local zone for a `timestamp without time zone`
    // column — silently wrong by the UTC offset, on top of the precision problem.
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it("still narrows to the one row", () => {
    const { params } = query(1);
    expect(params).toContain(UUID);
  });
});
