/**
 * `createArea` / `updateAreaMeta` must turn an alias collision into `AreaAliasTakenError` (→ 409).
 *
 * config-v4 Phase 14 stage 2b. This site was broken TWICE OVER, and either half alone was fatal:
 *
 *   `isUniqueViolation(err)`                       — read `err.code`, which drizzle ≥0.44 leaves undefined
 *   `constraintOf(err) === "areas_owner_alias_unique"` — read `err.constraint`, which PlanetScale strips
 *
 * So `POST /api/areas` with a taken shortname 500'd where it documents a 409. The second half is why
 * unwrapping the cause chain (the STEP 0 fix) was not enough on its own, and it is what these cases
 * exist to pin: every injected error has `constraint: undefined` and names its index in the `message`
 * only, which is precisely what the database sends.
 *
 * `createArea`'s error handling has three arms and they must stay separable — a lost handle race
 * (retry), an alias collision (409) and everything else (rethrow) — so all three are driven here.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

/** What the fake `areas` INSERT should throw, if anything. Consumed one attempt at a time. */
let insertFailures: unknown[] = [];
let txAttempts = 0;

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    return {
      async transaction(fn: (tx: unknown) => Promise<unknown>) {
        txAttempts++;
        const tx = {
          insert() {
            return {
              async values() {
                const failure = insertFailures.shift();
                if (failure) throw failure;
                return [];
              },
            };
          },
          update: updateChain,
        };
        return fn(tx);
      },
      update: updateChain,
    };
  },
}));

/**
 * `update(areas).set(set).where(eq(...))` — the writer's real arity, reproduced.
 *
 * 🛑 Not a detail. Collapsing this into one `async update()` makes `.set` undefined on a PROMISE, so the
 * rejection it already carries is never awaited: the worker dies on an unhandled rejection instead of
 * failing an assertion, and the failure looks like a crash in the fixture rather than a mock defect.
 */
function updateChain() {
  const chain = {
    set() {
      return chain;
    },
    async where() {
      const failure = insertFailures.shift();
      if (failure) throw failure;
      return [];
    },
  };
  return chain;
}

jest.mock("@/lib/areas/handles", () => ({
  allocateAreaHandle: async () => 1_000_042,
}));

jest.mock("@/lib/registry", () => ({
  DeviceRegistry: {
    ensureAreaForHandle: async () => {},
    uuidForRid: async () => "019f0000-0000-7000-8000-0000000dev01",
  },
}));

jest.mock("@/lib/kv-cache-manager", () => ({
  buildSubscriptionRegistry: async () => {},
}));

import { createArea, updateAreaMeta, AreaAliasTakenError } from "../create";
import { HandleAreaConflictError } from "@/lib/registry/device-registry";

/** The exact shape `liveone-dev` raises for a second area with the owner's existing slug. */
function wrappedAliasCollision(): Error {
  const pgError = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "areas_owner_alias_unique"',
    ),
    {
      code: "23505",
      severity: "ERROR",
      detail:
        "Key (owner_user_id, slug)=(p14-pgerr-owner, p14-pgerr-alias) already exists.",
      constraint: undefined,
      table: undefined,
      schema: undefined,
      routine: "_bt_check_unique",
    },
  );
  return Object.assign(new Error("Failed query: insert into areas …"), {
    cause: pgError,
  });
}

/** A 23505 the alias branch must NOT claim — `createArea` also touches `legacy_handles`. */
function wrappedHandleCollision(): Error {
  return Object.assign(
    new Error("Failed query: insert into legacy_handles …"),
    {
      cause: Object.assign(
        new Error(
          'duplicate key value violates unique constraint "legacy_handles_area_unique"',
        ),
        { code: "23505", constraint: undefined },
      ),
    },
  );
}

const INPUT = {
  ownerClerkUserId: "p14-pgerr-owner",
  displayName: "p14-pgerr area",
  alias: "p14-pgerr-alias",
  timezoneOffsetMin: 600,
  displayTimezone: "Australia/Melbourne",
  memberSystemIds: [],
};

describe("createArea — alias collision", () => {
  beforeEach(() => {
    insertFailures = [];
    txAttempts = 0;
  });

  it("raises AreaAliasTakenError (the 409) on `areas_owner_alias_unique`", async () => {
    insertFailures = [wrappedAliasCollision()];
    await expect(createArea(INPUT)).rejects.toBeInstanceOf(AreaAliasTakenError);
    expect(txAttempts).toBe(1); // an alias clash is terminal, not retried
  });

  it("still RETRIES a lost handle race", async () => {
    insertFailures = [
      new HandleAreaConflictError(
        1_000_042,
        "019f0000-0000-7000-8000-00000000a002",
        "019f0000-0000-7000-8000-00000000a001",
      ),
    ];
    const created = await createArea(INPUT);
    expect(txAttempts).toBe(2);
    expect(created.legacySystemId).toBe(1_000_042);
  });

  it("rethrows a 23505 on a DIFFERENT index rather than reporting 'shortname taken'", async () => {
    insertFailures = [wrappedHandleCollision()];
    await expect(createArea(INPUT)).rejects.not.toBeInstanceOf(
      AreaAliasTakenError,
    );
    expect(txAttempts).toBe(1);
  });

  it("rethrows a non-unique failure unchanged", async () => {
    insertFailures = [
      Object.assign(new Error("Failed query: insert into areas …"), {
        cause: Object.assign(new Error('null value in column "name"'), {
          code: "23502",
        }),
      }),
    ];
    await expect(createArea(INPUT)).rejects.toThrow(/Failed query/);
  });
});

describe("updateAreaMeta — alias collision", () => {
  beforeEach(() => {
    insertFailures = [];
    txAttempts = 0;
  });

  it("raises AreaAliasTakenError (the 409) on `areas_owner_alias_unique`", async () => {
    insertFailures = [wrappedAliasCollision()];
    await expect(
      updateAreaMeta("019f0000-0000-7000-8000-00000000a001", {
        alias: "p14-pgerr-alias",
      }),
    ).rejects.toBeInstanceOf(AreaAliasTakenError);
  });

  it("rethrows anything else", async () => {
    insertFailures = [wrappedHandleCollision()];
    await expect(
      updateAreaMeta("019f0000-0000-7000-8000-00000000a001", {
        alias: "p14-pgerr-alias",
      }),
    ).rejects.not.toBeInstanceOf(AreaAliasTakenError);
  });
});
