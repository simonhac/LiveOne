/**
 * `createDashboard` / `updateDashboard` must turn a SLUG collision — and ONLY a slug collision — into
 * `DashboardAliasTakenError` (→ 409).
 *
 * config-v4 Phase 14 stage 11, discharging the follow-up stage 2b left behind. STEP 0 fixed half of
 * this: the predicate read `err.code`, which drizzle ≥0.44 leaves undefined, so the 409 branch never
 * fired and both write paths answered a bare 500 with an empty body. Its replacement was
 * `isPgUniqueViolation` — "any 23505 here is an alias collision" — which is too lenient, because
 * `dashboards` carries a SECOND unique index (`dashboards_legacy_id_unique`, over the frozen
 * pre-cutover int). A clash there would have surfaced to the user as "That shortname is already in
 * use": a plausible message, a plausible status, and a real defect hidden behind both.
 *
 * BOTH branches are driven here, because tightening the predicate is a behaviour change on a path
 * STEP 0 verified — the alias case must still 409 with the same error, and the non-alias case must now
 * propagate instead of masquerading.
 *
 * 🛑 Every injected error is the MEASURED shape: a drizzle wrapper whose `cause` is the `pg` error,
 * with `constraint` UNDEFINED and the index name in the `message` only. That is what PlanetScale
 * actually sends (see `lib/db/pg-error.ts`); a `{code:"23505", constraint:"…"}` fixture would pass
 * against code that cannot work in production.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

/** Thrown by the next `execute()` / `update().set().where()`, if set. */
let nextFailure: unknown = null;

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    return {
      // config-v4 Phase 14 stage 15: `createDashboard` INSERTs via raw `sql` rather than
      // `db.insert(dashboards)`, because `descriptor` is NOT NULL but deliberately undeclared in
      // schema.ts (see that function). The error path is unchanged — `isUniqueViolationOn` walks the
      // `cause` chain and never inspects which drizzle API raised it — but the mock must follow the
      // call that is actually made, or every assertion below would pass against nothing.
      async execute() {
        if (nextFailure) throw nextFailure;
        return { rows: [{ id: "019f0000-0000-7000-8000-0000000000aa" }] };
      },
      update() {
        const chain = {
          set() {
            return chain;
          },
          async where() {
            if (nextFailure) throw nextFailure;
            return [];
          },
        };
        return chain;
      },
    };
  },
}));

import {
  createDashboard,
  updateDashboard,
  DashboardAliasTakenError,
} from "../dashboards";
import { Dashboard } from "@/lib/ids";

const DASH_ID = Dashboard.encode("019f0000-0000-7000-8000-0000000000aa");

/** A 23505 exactly as `liveone-dev` raises it, inside drizzle's wrapper: name in the message only. */
function wrappedUniqueViolation(indexName: string): Error {
  const pgError = Object.assign(
    new Error(`duplicate key value violates unique constraint "${indexName}"`),
    {
      code: "23505",
      severity: "ERROR",
      detail: "Key (owner_user_id, slug)=(user_x, taken) already exists.",
      constraint: undefined,
      table: undefined,
      schema: undefined,
      routine: "_bt_check_unique",
    },
  );
  return Object.assign(new Error("Failed query: insert into dashboards …"), {
    cause: pgError,
  });
}

const create = () =>
  createDashboard({
    ownerClerkUserId: "user_x",
    displayName: "d",
    alias: "taken",
  });

describe("dashboards — alias collision vs every other unique violation", () => {
  beforeEach(() => {
    nextFailure = null;
  });

  describe("the alias branch still 409s (unchanged by the tightening)", () => {
    it("createDashboard → DashboardAliasTakenError", async () => {
      nextFailure = wrappedUniqueViolation("dashboards_owner_alias_unique");
      await expect(create()).rejects.toBeInstanceOf(DashboardAliasTakenError);
      await expect(create()).rejects.toThrow("alias already in use");
    });

    it("updateDashboard → DashboardAliasTakenError", async () => {
      nextFailure = wrappedUniqueViolation("dashboards_owner_alias_unique");
      await expect(
        updateDashboard(DASH_ID, { alias: "taken" }),
      ).rejects.toBeInstanceOf(DashboardAliasTakenError);
    });
  });

  describe("a NON-alias unique violation no longer masquerades as one", () => {
    it("createDashboard rethrows a dashboards_legacy_id_unique clash", async () => {
      nextFailure = wrappedUniqueViolation("dashboards_legacy_id_unique");
      await expect(create()).rejects.toThrow(/Failed query/);
      await expect(create()).rejects.not.toBeInstanceOf(
        DashboardAliasTakenError,
      );
    });

    it("updateDashboard rethrows a dashboards_legacy_id_unique clash", async () => {
      nextFailure = wrappedUniqueViolation("dashboards_legacy_id_unique");
      await expect(
        updateDashboard(DASH_ID, { alias: "taken" }),
      ).rejects.toThrow(/Failed query/);
    });

    it("rethrows a 23505 whose index cannot be named (pg-error is strict on purpose)", async () => {
      // PlanetScale strips `constraint`; if the message shape ever changes too, the safe answer is a
      // 500, NOT a 409 claiming the shortname is taken.
      nextFailure = Object.assign(new Error("Failed query: insert …"), {
        cause: Object.assign(new Error("duplicate key value"), {
          code: "23505",
          constraint: undefined,
        }),
      });
      await expect(create()).rejects.toThrow(/Failed query/);
    });

    it("rethrows a non-unique failure (FK)", async () => {
      nextFailure = Object.assign(new Error("Failed query: insert …"), {
        cause: Object.assign(new Error("violates foreign key constraint"), {
          code: "23503",
        }),
      });
      await expect(create()).rejects.toThrow(/Failed query/);
    });
  });
});
