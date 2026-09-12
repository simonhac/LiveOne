/**
 * The claim, executed against a real Postgres.
 *
 * This is the test that would have caught the microsecond bug end to end, and the reason it did not
 * exist is the reason the bug shipped: `evaluate.test.ts` mocks `@/lib/automations/store` wholesale,
 * so nothing anywhere ran this module's SQL. A predicate that matched nothing was indistinguishable
 * from one that worked.
 *
 * 🛑 The fixture is created through `store.create()` ON PURPOSE — so `updated_at` comes from the
 * column's `DEFAULT now()` and carries microseconds, exactly like the rows in production. Stamping
 * it from JS here would reproduce the shape that already worked and prove nothing.
 *
 * Writes to whatever `.env.local` points at, which is `liveone-dev` — never prod (the
 * `assertDbEnvironmentMatches` guard refuses a prod connection outside production). Cleans up after
 * itself; skips rather than fails when there is no database configured.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { areas } from "@/lib/db/planetscale/schema";
import * as store from "@/lib/automations/store";
import type {
  AutomationAction,
  AutomationTrigger,
} from "@/lib/db/planetscale/schema";

const TRIGGER = {
  kind: "exercise",
  source: {
    kind: "derivation",
    derivationId: "00000000-0000-4000-8000-000000000000",
  },
  schedule: { weekdays: ["thu"], time: "09:00", graceMinutes: 180 },
  unless: {
    loadPointId: "00000000-0000-4000-8000-000000000000",
    minMinutes: 30,
    minLoadKw: 1.5,
    dipToleranceSeconds: 180,
    withinDays: 7,
  },
} as unknown as AutomationTrigger;

const ACTION = {
  kind: "point-action",
  pointId: "00000000-0000-4000-8000-000000000000",
  action: "set_value",
  value: 30,
} as unknown as AutomationAction;

const db = planetscaleDb;
const maybe = db ? describe : describe.skip;

maybe("claimExerciseDispatch against a real Postgres", () => {
  let id: string | null = null;

  beforeAll(async () => {
    const [area] = await db!.select({ id: areas.id }).from(areas).limit(1);
    if (!area) throw new Error("no areas in the target database");
    const row = await store.create({
      areaId: area.id,
      name: `__test__ claim precision ${Date.now()}`,
      mode: "standing",
      trigger: TRIGGER,
      action: ACTION,
      enabled: false, // never evaluated by a cron pointed at the same branch
    });
    id = row.id;
  });

  afterAll(async () => {
    if (id) await store.remove(id);
  });

  it("🛑 the fixture really carries sub-millisecond precision", async () => {
    // If this ever stops being true the bug is gone for a different reason (the column became
    // timestamp(3), or create() started stamping from JS) — and the assertions below stop proving
    // anything, so the failure should be loud rather than silent.
    const res = await db!.execute(
      sql`select updated_at::text as t from automations where id = ${id}`,
    );
    const text = String((res.rows[0] as { t: string }).t);
    const fraction = text.split(".")[1] ?? "";
    expect(fraction.length).toBeGreaterThan(3);
  });

  it("claims a row whose updated_at came from DEFAULT now()", async () => {
    const row = await store.getById(id!);
    expect(await store.claimExerciseDispatch(id!, row!.updatedAt)).toBe(true);
  });

  it("refuses a stale updated_at — the race the CAS exists for", async () => {
    const stale = (await store.getById(id!))!.updatedAt;
    expect(await store.claimExerciseDispatch(id!, stale)).toBe(true);
    expect(await store.claimExerciseDispatch(id!, stale)).toBe(false);
  });

  it("claims again once the caller re-reads", async () => {
    const fresh = (await store.getById(id!))!.updatedAt;
    expect(await store.claimExerciseDispatch(id!, fresh)).toBe(true);
  });
});
