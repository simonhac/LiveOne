/**
 * `createDashboardShareToken`'s collision RETRY.
 *
 * The loop was decorative. `continue` was gated on `(err as {code?: string})?.code === "23505"`, which
 * drizzle ≥0.44 never populates, so the one event the loop exists for — two 3-word phrases colliding on
 * `share_tokens_pkey` — rethrew on the first attempt and 500'd the mint. There is no way to force a real
 * phrase collision (that is the point of the phrase space), so this drives the loop directly by making
 * the first INSERT raise the wrapped 23505 that a real collision raises.
 *
 * 🛑 The injected error is the MEASURED shape — a `DrizzleQueryError`-style wrapper whose `cause` is the
 * `pg` error, with `constraint` undefined and the index name only in the message. A `{code:"23505"}`
 * fixture would pass against the OLD code too and prove nothing.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

let attempts: Array<Record<string, unknown>> = [];
/** Thrown by attempt 1 only, unless `failEvery` — the retry then has to succeed on attempt 2. */
let failFirstWith: unknown = null;
let failEvery = false;

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    return {
      insert() {
        return {
          async values(row: Record<string, unknown>) {
            attempts.push(row);
            if (failFirstWith && (failEvery || attempts.length === 1))
              throw failFirstWith;
            return [];
          },
        };
      },
    };
  },
}));

import { createDashboardShareToken } from "../sharing";
import { Dashboard } from "@/lib/ids";

const DASH_UUID = "019f0000-0000-7000-8000-00000000d001";
const DASH_ID = Dashboard.encode(DASH_UUID);

/** A `share_tokens_pkey` violation exactly as `liveone-dev` raises it, inside drizzle's wrapper. */
function wrappedPkeyCollision(token: string): Error {
  const pgError = Object.assign(
    new Error(
      'duplicate key value violates unique constraint "share_tokens_pkey"',
    ),
    {
      code: "23505",
      severity: "ERROR",
      detail: `Key (token)=(${token}) already exists.`,
      constraint: undefined,
      table: undefined,
      schema: undefined,
      routine: "_bt_check_unique",
    },
  );
  return Object.assign(new Error("Failed query: insert into share_tokens …"), {
    cause: pgError,
  });
}

describe("createDashboardShareToken — PK collision retry", () => {
  beforeEach(() => {
    attempts = [];
    failFirstWith = null;
    failEvery = false;
  });

  it("retries with a FRESH phrase after a wrapped 23505 and succeeds", async () => {
    failFirstWith = wrappedPkeyCollision("leaping-fizzy-wombat");
    const result = await createDashboardShareToken({
      dashboardId: DASH_ID,
      label: "p14 retry",
    });
    expect(attempts).toHaveLength(2); // the retry actually happened
    expect(attempts[0].token).not.toBe(attempts[1].token); // …with a new phrase
    expect(result.token).toBe(attempts[1].token); // …and that phrase is what the caller gets
    expect(result.expiresAtMs).toBeNull();
  });

  it("does NOT swallow a non-collision failure", async () => {
    failFirstWith = Object.assign(new Error("Failed query: insert …"), {
      cause: Object.assign(
        new Error(
          'insert violates foreign key constraint "share_tokens_dashboard_id_fkey"',
        ),
        { code: "23503" },
      ),
    });
    await expect(
      createDashboardShareToken({ dashboardId: DASH_ID, label: "p14 fk" }),
    ).rejects.toThrow(/Failed query/);
    expect(attempts).toHaveLength(1); // no retry
  });

  it("does NOT retry a unique violation on some OTHER index", async () => {
    // Nothing raises this today (the PK is `share_tokens`' only unique), but a future index must not be
    // silently absorbed into "phrase collision, try again" — that would loop five times and then report
    // "failed to allocate unique dashboard share token" for an unrelated defect.
    failFirstWith = Object.assign(new Error("Failed query: insert …"), {
      cause: Object.assign(
        new Error(
          'duplicate key value violates unique constraint "share_tokens_label_unique"',
        ),
        { code: "23505", constraint: undefined },
      ),
    });
    await expect(
      createDashboardShareToken({ dashboardId: DASH_ID, label: "p14 other" }),
    ).rejects.toThrow(/Failed query/);
    expect(attempts).toHaveLength(1);
  });

  it("gives up after 5 collisions rather than looping forever", async () => {
    failFirstWith = wrappedPkeyCollision("leaping-fizzy-wombat");
    failEvery = true;
    await expect(
      createDashboardShareToken({ dashboardId: DASH_ID, label: "p14 give up" }),
    ).rejects.toThrow("failed to allocate unique dashboard share token");
    expect(attempts).toHaveLength(5);
    expect(new Set(attempts.map((a) => a.token)).size).toBe(5); // 5 DISTINCT phrases tried
  });
});
