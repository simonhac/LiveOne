import { describe, expect, it } from "@jest/globals";
import { SLOTS_BY_KIND, writeDerivationSources } from "../sources";

/**
 * A db stand-in that records what it was asked to do. The point of these tests is ORDER: the slot
 * check has to happen before the DELETE, because `writeDerivationSources` is delete-then-insert and
 * a rejection after the delete leaves the derivation with no wiring at all.
 */
function recordingDb() {
  const calls: string[] = [];
  const db = {
    select: () => ({
      from: () => ({ where: async () => [] }),
    }),
    delete: () => {
      calls.push("delete");
      return { where: async () => undefined };
    },
    insert: () => {
      calls.push("insert");
      return { values: async () => undefined };
    },
  };
  return { db: db as never, calls };
}

describe("writeDerivationSources", () => {
  it("mirrors the per-kind slot vocabulary of derivation_sources_slot_check", () => {
    expect(SLOTS_BY_KIND["run-detector"]).toEqual([
      "signal",
      "energy",
      "boundary",
    ]);
    expect(SLOTS_BY_KIND["hws-model"]).toEqual(["power"]);
  });

  // 🛑 The regression this exists for: the PATCH route's boundary leg used to reach here for ANY
  // kind. On an hws-model that deleted its sole `power` row and inserted nothing — the model
  // silently vanished from `listEnabledHwsModels`, with a 200 on the wire.
  it("refuses a slot the kind does not have BEFORE deleting anything", async () => {
    const { db, calls } = recordingDb();
    await expect(
      writeDerivationSources(db, {
        derivationId: "d1",
        kind: "hws-model",
        role: null,
        slots: { boundary: "p1" },
      }),
    ).rejects.toThrow(/no slot\(s\) boundary/);
    expect(calls).toEqual([]);
  });

  it("refuses an unknown kind rather than writing an unconstrained row", async () => {
    const { db, calls } = recordingDb();
    await expect(
      writeDerivationSources(db, {
        derivationId: "d1",
        kind: "vibes",
        role: null,
        slots: { signal: "p1" },
      }),
    ).rejects.toThrow(/unknown derivation kind/);
    expect(calls).toEqual([]);
  });

  // Clearing every slot is legal and must still DELETE — that is how a boundary is unwired.
  it("deletes without inserting when no slot is wired", async () => {
    const { db, calls } = recordingDb();
    await writeDerivationSources(db, {
      derivationId: "d1",
      kind: "run-detector",
      role: "generator",
      slots: { signal: null, energy: undefined, boundary: null },
    });
    expect(calls).toEqual(["delete"]);
  });
});
