/**
 * `replaceDashboardGrants` — the full-replace diff behind `PUT /api/v4/dashboards/{id}/grants`.
 *
 * 🛑 A full replace is a DELETE PREDICATE IN DISGUISE, and the repo has been burned by testing one
 * against an empty table: a smoke run that cleared the dependents first only ever ran its delete
 * against zero rows, proving the SQL parses and nothing else. Under- and over-delete are both silent
 * from the caller's side — the response looks identical.
 *
 * So the cases that matter here all start from a POPULATED membership:
 *
 *   · two grantees, PUT keeps one and drops the other  → exactly one delete, naming exactly one id
 *   · then a PUT that ADDS a third while REMOVING another (the sideways move)
 *   · a role change on a kept member is an UPDATE, never a delete+reinsert (created_at must survive)
 *   · `[]` removes everyone — and it is the case a `notInArray(keep)` predicate would get wrong
 *
 * The fake DB records every statement, so the assertions are about WHICH ROWS the delete named, not
 * merely about the returned summary.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

interface Row {
  userId: string;
  role: string;
}

let existing: Row[] = [];
let deletes: string[][] = [];
let inserted: Array<{ userId: string; role: string }> = [];
let conflictSetKeys: string[] = [];
let txCount = 0;

/**
 * `inArray(col, values)` is captured by reading the drizzle SQL object's chunks. Simpler and more
 * honest than re-implementing the operator: the test asserts on the literal values the DAO passed.
 */
function valuesOf(condition: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      const q = node as Record<string, unknown>;
      if (typeof q.value === "string") out.push(q.value);
      if (Array.isArray(q.value)) q.value.forEach(walk);
      if (q.queryChunks) walk(q.queryChunks);
    }
    if (typeof node === "string" && node.startsWith("user_")) out.push(node);
  };
  walk(condition);
  return out;
}

jest.mock("@/lib/db/planetscale", () => ({
  requirePlanetscaleDb() {
    return {
      async transaction(fn: (tx: unknown) => Promise<unknown>) {
        txCount++;
        const tx = {
          select() {
            return {
              from() {
                return {
                  async where() {
                    return existing.map((r) => ({ ...r }));
                  },
                };
              },
            };
          },
          delete() {
            return {
              async where(condition: unknown) {
                const named = valuesOf(condition).filter((v) =>
                  v.startsWith("user_"),
                );
                deletes.push(named);
                existing = existing.filter((r) => !named.includes(r.userId));
                return [];
              },
            };
          },
          insert() {
            return {
              values(rows: Array<{ userId: string; role: string }>) {
                inserted.push(...rows.map((r) => ({ ...r })));
                return {
                  async onConflictDoUpdate(args: {
                    set: Record<string, unknown>;
                  }) {
                    conflictSetKeys = Object.keys(args.set);
                    for (const row of rows) {
                      const hit = existing.find((e) => e.userId === row.userId);
                      if (hit) hit.role = row.role;
                      else
                        existing.push({
                          userId: row.userId,
                          role: row.role,
                        });
                    }
                    return [];
                  },
                };
              },
            };
          },
        };
        return fn(tx);
      },
    };
  },
}));

import { replaceDashboardGrants } from "../grants";
import { Dashboard } from "@/lib/ids";

const DASH = Dashboard.encode("019f0000-0000-7000-8000-00000000d001");
const ALICE = "user_alice";
const BOB = "user_bob";
const CARLA = "user_carla";

beforeEach(() => {
  existing = [];
  deletes = [];
  inserted = [];
  conflictSetKeys = [];
  txCount = 0;
});

describe("replaceDashboardGrants — driven from a POPULATED membership", () => {
  it("two grantees, PUT keeps one and drops the other", async () => {
    existing = [
      { userId: ALICE, role: "viewer" },
      { userId: BOB, role: "viewer" },
    ];
    const result = await replaceDashboardGrants(DASH, [
      { clerkUserId: ALICE, role: "viewer" },
    ]);

    // The DELETE named EXACTLY Bob. Not "a delete ran"; not "Alice survived by luck".
    expect(deletes).toEqual([[BOB]]);
    expect(result).toEqual({
      added: [],
      updated: [],
      unchanged: [ALICE],
      removed: [BOB],
    });
    expect(existing.map((r) => r.userId)).toEqual([ALICE]);
    expect(txCount).toBe(1); // one transaction, so a partial replace cannot be observed
  });

  it("adds a third while removing another (the sideways move)", async () => {
    existing = [
      { userId: ALICE, role: "viewer" },
      { userId: BOB, role: "viewer" },
    ];
    const result = await replaceDashboardGrants(DASH, [
      { clerkUserId: ALICE, role: "viewer" },
      { clerkUserId: CARLA, role: "admin" },
    ]);

    expect(deletes).toEqual([[BOB]]);
    expect(result.added).toEqual([CARLA]);
    expect(result.removed).toEqual([BOB]);
    expect(result.unchanged).toEqual([ALICE]);
    expect(existing.map((r) => r.userId).sort()).toEqual([ALICE, CARLA]);
  });

  it("a role change on a KEPT member is an update, never a delete", async () => {
    existing = [
      { userId: ALICE, role: "viewer" },
      { userId: BOB, role: "viewer" },
    ];
    const result = await replaceDashboardGrants(DASH, [
      { clerkUserId: ALICE, role: "admin" },
      { clerkUserId: BOB, role: "viewer" },
    ]);

    expect(deletes).toEqual([]); // 🛑 nobody left, so nothing may be deleted
    expect(result).toEqual({
      added: [],
      updated: [ALICE],
      unchanged: [BOB],
      removed: [],
    });
    expect(existing.find((r) => r.userId === ALICE)?.role).toBe("admin");
    // `created_at` is NOT in the conflict SET, so a re-stated member keeps their join date.
    expect(conflictSetKeys).toEqual(["role"]);
  });

  it("an empty list removes everyone — the case a notInArray(keep) predicate gets wrong", async () => {
    existing = [
      { userId: ALICE, role: "viewer" },
      { userId: BOB, role: "admin" },
    ];
    const result = await replaceDashboardGrants(DASH, []);

    expect(deletes).toEqual([[ALICE, BOB]]);
    expect(result.removed).toEqual([ALICE, BOB]);
    expect(inserted).toEqual([]); // no empty INSERT is issued
    expect(existing).toEqual([]);
  });

  it("a no-op replace issues no delete and no state change", async () => {
    existing = [{ userId: ALICE, role: "viewer" }];
    const result = await replaceDashboardGrants(DASH, [
      { clerkUserId: ALICE, role: "viewer" },
    ]);
    expect(deletes).toEqual([]);
    expect(result.unchanged).toEqual([ALICE]);
    expect(existing).toEqual([{ userId: ALICE, role: "viewer" }]);
  });

  it("refuses a duplicate grantee rather than silently collapsing it", async () => {
    existing = [{ userId: ALICE, role: "viewer" }];
    await expect(
      replaceDashboardGrants(DASH, [
        { clerkUserId: BOB, role: "viewer" },
        { clerkUserId: BOB, role: "admin" },
      ]),
    ).rejects.toThrow("duplicate grantee");
    expect(txCount).toBe(0); // rejected BEFORE the transaction — nothing applied
    expect(existing).toEqual([{ userId: ALICE, role: "viewer" }]);
  });

  it("refuses a malformed dashboard id", async () => {
    await expect(replaceDashboardGrants("not-a-typeid", [])).rejects.toThrow(
      "invalid dashboard id",
    );
    expect(txCount).toBe(0);
  });
});
