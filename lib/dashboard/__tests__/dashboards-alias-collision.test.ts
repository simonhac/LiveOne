/**
 * `createDashboard` / `updateDashboard` must turn a SLUG collision — and ONLY a slug collision — into
 * `DashboardAliasTakenError` (→ 409).
 *
 * Two ways this has been got wrong, and both are driven here. A predicate reading `err.code` never
 * fires (drizzle ≥0.44 leaves it undefined), so both write paths answer a bare 500 with an empty
 * body. A predicate reading "any 23505 here is an alias collision" is too lenient, because
 * `dashboards` carries other unique constraints (here `dashboards_pkey`; there was also a `legacy_id`
 * unique until migration 0062 dropped that column) — a clash on one of those surfaces to the user as
 * "That shortname is already in use": a plausible message, a plausible status, and a real defect
 * hidden behind both. So the alias case must 409, and the non-alias case must propagate.
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
      // `createDashboard` runs in a transaction (row + revision-1 history in one commit). The tx
      // object exposes the same chains, so the error-path measurements below are unchanged — the
      // failure still surfaces through `returning()`.
      async transaction(fn: (tx: unknown) => Promise<unknown>) {
        return fn(this);
      },
      // 🛑 The mock must follow the drizzle call `createDashboard` actually makes, or every
      // assertion below passes against nothing. The error path itself does not care which API raised
      // it — `isUniqueViolationOn` walks the `cause` chain — but this suite has gone red on exactly
      // that swap before.
      insert() {
        return {
          values() {
            return {
              async returning() {
                if (nextFailure) throw nextFailure;
                return [{ id: "019f0000-0000-7000-8000-0000000000aa" }];
              },
            };
          },
        };
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
    it("createDashboard rethrows a dashboards_pkey clash", async () => {
      nextFailure = wrappedUniqueViolation("dashboards_pkey");
      await expect(create()).rejects.toThrow(/Failed query/);
      await expect(create()).rejects.not.toBeInstanceOf(
        DashboardAliasTakenError,
      );
    });

    it("updateDashboard rethrows a dashboards_pkey clash", async () => {
      nextFailure = wrappedUniqueViolation("dashboards_pkey");
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
