/**
 * The claim, executed against a real Postgres.
 *
 * This is the test that would have caught the microsecond bug end to end, and the reason it did not
 * exist is the reason the bug shipped: `evaluate.test.ts` mocks `@/lib/automations/store` wholesale,
 * so nothing anywhere ran this module's SQL. A predicate that matched nothing was indistinguishable
 * from one that worked.
 *
 * 🛑 The fixture is created through `store.create()` ON PURPOSE — every column the claim depends on
 * then comes from the DATABASE's defaults (`revision` = 1, `updated_at` = `now()`), exactly like the
 * rows in production. Stamping them from JS here would reproduce the shape that already worked and
 * prove nothing. It also pins the two halves of migration 0064 against the live branch: `updated_at`
 * now comes back with no sub-millisecond digits, and `revision` exists and increments.
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

/** An arbitrary but fixed slot instant, whole milliseconds so the round trip is lossless. */
const SLOT_MS = new Date("2026-09-10T09:00:00+10:00").getTime();

const db = planetscaleDb;
const maybe = db ? describe : describe.skip;

maybe("claimExerciseSlot against a real Postgres", () => {
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

  it("🛑 the DEFAULT now() stamp is storable as a JS Date — migration 0064", async () => {
    // The bug was that this was FALSE: the column was timestamp(6), so `now()` wrote
    // `…43.616884`, a value `new Date(…)` cannot carry. If this regresses, the class is back —
    // whatever the claim happens to be keyed on today.
    const res = await db!.execute(
      sql`select updated_at::text as t from automations where id = ${id}`,
    );
    const text = String((res.rows[0] as { t: string }).t);
    const fraction = text.split(".")[1] ?? "";
    expect(fraction.length).toBeLessThanOrEqual(3);
  });

  it("claims a row whose revision came from the column default, and consumes the slot", async () => {
    const row = await store.getById(id!);
    expect(row!.revision).toBe(1);
    expect(row!.lastTriggeredRunStart).toBeNull();

    const claim = await store.claimExerciseSlot(id!, row!.revision, SLOT_MS);
    // 🛑 It returns the revision it TOOK, not a boolean: `recordExerciseOutcome` compares against
    // this, and comparing against the row's pre-claim revision would refuse its own write.
    expect(claim).toEqual({ revision: 2 });

    const after = await store.getById(id!);
    expect(after!.revision).toBe(2);
    // 🛑 The consume is in the SAME statement as the claim. This is what closes the window a second
    // tick used to dispatch through, and it is only true if the UPDATE really wrote both columns.
    expect(after!.lastTriggeredRunStart).toEqual(new Date(SLOT_MS));
  });

  it("refuses a stale revision — the race the CAS exists for", async () => {
    const stale = (await store.getById(id!))!.revision;
    expect(await store.claimExerciseSlot(id!, stale, SLOT_MS)).not.toBeNull();
    expect(await store.claimExerciseSlot(id!, stale, SLOT_MS)).toBeNull();
  });

  it("claims again once the caller re-reads", async () => {
    const fresh = (await store.getById(id!))!.revision;
    expect(await store.claimExerciseSlot(id!, fresh, SLOT_MS)).not.toBeNull();
  });

  it("🛑 every writer bumps the version, so an unrelated write invalidates a held claim", async () => {
    const before = (await store.getById(id!))!.revision;
    await store.patch(id!, { name: `__test__ renamed ${Date.now()}` });
    const after = (await store.getById(id!))!.revision;
    expect(after).toBe(before + 1);
    // Benign and deliberate: a rule PATCHed between `listEnabled()` and `fireExercise()` loses the
    // claim and retries on the next tick, well inside the grace window. Silently dispatching against
    // a definition that has since changed is the outcome worth avoiding.
    expect(await store.claimExerciseSlot(id!, before, SLOT_MS)).toBeNull();
  });

  // ── the outcome write, which is now a CAS too ──────────────────────────────────────────────────

  const context = (outcome: "fired" | "waiting") =>
    ({ slotAt: SLOT_MS, outcome, decidedAt: Date.now() }) as never;

  it("🛑 refuses an outcome whose expected revision has moved on", async () => {
    const stale = (await store.getById(id!))!.revision;
    await store.patch(id!, { name: `__test__ moved ${Date.now()}` });

    const applied = await store.recordExerciseOutcome(id!, {
      context: context("fired"),
      runStart: new Date(SLOT_MS),
      disable: true,
      nowMs: Date.now(),
      expectRevision: stale,
    });

    // 🛑 And critically the row is UNTOUCHED — this write carries `enabled: false`, so a stale
    // decision applying here is how a rule that had just been given another occurrence went dark.
    expect(applied).toBe(false);
    expect((await store.getById(id!))!.enabled).toBe(false); // the fixture was created disabled
    expect((await store.getById(id!))!.lastTriggeredAt).toBeNull();
  });

  it("applies an outcome against the current revision, and RELEASES the slot to a prior watermark", async () => {
    const prior = new Date(SLOT_MS - 7 * 24 * 3_600_000);
    await store.patch(id!, { lastTriggeredRunStart: prior });

    const claim = await store.claimExerciseSlot(
      id!,
      (await store.getById(id!))!.revision,
      SLOT_MS,
    );
    expect((await store.getById(id!))!.lastTriggeredRunStart).toEqual(
      new Date(SLOT_MS),
    );

    // The hub declined: put the watermark back where it was, NOT to null. Nulling it would re-arm
    // whatever earlier occurrence it was holding.
    const applied = await store.recordExerciseOutcome(id!, {
      context: context("waiting"),
      runStart: prior,
      nowMs: Date.now(),
      expectRevision: claim!.revision,
    });

    expect(applied).toBe(true);
    expect((await store.getById(id!))!.lastTriggeredRunStart).toEqual(prior);
  });

  it("leaves the watermark alone when no runStart is given", async () => {
    const held = (await store.getById(id!))!.lastTriggeredRunStart;
    expect(held).not.toBeNull();

    const applied = await store.recordExerciseOutcome(id!, {
      context: context("waiting"),
      nowMs: Date.now(),
      expectRevision: (await store.getById(id!))!.revision,
    });

    expect(applied).toBe(true);
    expect((await store.getById(id!))!.lastTriggeredRunStart).toEqual(held);
  });
});
