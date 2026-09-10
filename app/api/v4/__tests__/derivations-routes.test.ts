/**
 * The derivations routes' refusals — the ones that protect data rather than validate a body.
 *
 * Authorization itself is `lib/derivations/__tests__/scope.test.ts`'s subject and is stubbed open
 * here; what these cases pin is what the handlers do ONCE a caller is allowed in. Two of them are
 * the DELETE interlocks, which are the first destructive verb this domain has ever had, and one of
 * which (the relied-upon check) the v4 surface smoke deliberately cannot reach: provoking it there
 * would mean disabling a live production detector.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest } from "next/server";

jest.mock("@/lib/derivations/scope", () => ({
  loadDerivation: jest.fn(),
  listReadableDerivations: jest.fn(),
  readRecord: jest.fn(),
  requireWriteOnDevices: jest.fn(),
}));
jest.mock("@/lib/integrity/http", () => ({ refuseIfReliedUpon: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { refuseIfReliedUpon } from "@/lib/integrity/http";
import { loadDerivation } from "@/lib/derivations/scope";
import type { DerivationRecord } from "@/lib/derivations/scope";
import { handleDelete, handlePatch } from "@/lib/derivations/v4-routes";

const DX = "0199aaaa-0000-7000-8000-000000000001";
const DXID = "dx_01hnnnnnnnnnnnnnnnnnnnnnnn";

function record(overrides: Record<string, unknown> = {}): DerivationRecord {
  return {
    row: {
      id: DX,
      kind: "run-detector",
      role: "generator",
      name: "generator runs",
      enabled: false,
      output: "intervals",
      outputPointId: null,
      params: {},
      sourcePoints: {},
      ...overrides,
    },
    sources: [],
    devices: [],
  } as never;
}

/**
 * A db that records the destructive calls, so "did it delete?" is answerable. `rowsDeleted` is what
 * the conditional DELETE (`… AND enabled = false`) returns — 0 means the row was re-enabled between
 * the interlock and the statement.
 */
function fakeDb(rowsDeleted = 1) {
  const calls: string[] = [];
  return {
    calls,
    db: {
      delete: () => {
        calls.push("delete");
        return {
          where: () => ({
            returning: async () =>
              rowsDeleted > 0 ? [{ id: DX }] : ([] as { id: string }[]),
          }),
        };
      },
    },
  };
}

function del(force = false) {
  return handleDelete(
    new NextRequest(
      `http://localhost/api/v4/derivations/${DXID}${force ? "?force=true" : ""}`,
      { method: "DELETE" },
    ),
    DXID,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(refuseIfReliedUpon).mockResolvedValue({ forced: [] } as never);
});

describe("DELETE /api/v4/derivations/{dx_}", () => {
  // 🛑 Interlock 1, and it is NOT waivable. Disabling is one PATCH, it is reversible, and it makes
  // the operator watch the thing stop before destroying it — a `--force` that skipped straight from
  // "live" to "gone" would make the most consequential operation in this domain the easiest to typo.
  it("refuses a live derivation, and `?force=true` does not waive it", async () => {
    jest
      .mocked(loadDerivation)
      .mockResolvedValue({ record: record({ enabled: true }) } as never);
    const { db, calls } = fakeDb();
    jest.mocked(requirePlanetscaleDb).mockReturnValue(db as never);

    for (const forced of [false, true]) {
      const res = await del(forced);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { detail: { code: string } };
      expect(body.detail.code).toBe("derivation-enabled");
    }
    expect(calls).toEqual([]);
    // The second interlock is never even consulted — the first one is terminal.
    expect(refuseIfReliedUpon).not.toHaveBeenCalled();
  });

  // Interlock 2: a year of `derived_intervals` goes with the row (ON DELETE CASCADE, migration
  // 0040), so it is named before it goes rather than counted afterwards.
  it("refuses a disabled derivation that something still relies upon", async () => {
    jest
      .mocked(loadDerivation)
      .mockResolvedValue({ record: record() } as never);
    const { db, calls } = fakeDb();
    jest.mocked(requirePlanetscaleDb).mockReturnValue(db as never);
    jest.mocked(refuseIfReliedUpon).mockResolvedValue({
      response: new Response(null, { status: 409 }),
    } as never);

    expect((await del()).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("deletes once both interlocks pass, and reports what was overridden", async () => {
    jest
      .mocked(loadDerivation)
      .mockResolvedValue({ record: record() } as never);
    const { db, calls } = fakeDb();
    jest.mocked(requirePlanetscaleDb).mockReturnValue(db as never);
    jest.mocked(refuseIfReliedUpon).mockResolvedValue({
      forced: [{ kind: "intervals", id: "77" }],
    } as never);

    const res = await del(true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: { id: string };
      forced: unknown[];
    };
    expect(calls).toEqual(["delete"]);
    // "I overrode 1 dependent" and "there was nothing to override" must not look the same in a log.
    expect(body.forced).toHaveLength(1);
    expect(body.deleted.id).toBeDefined();
  });

  // 🛑 The race (found in review): the interlock reads a snapshot, and a PATCH can re-enable the
  // detector between that read and the DELETE. The statement therefore RE-STATES `enabled = false`
  // in its WHERE, so the guard is atomic with the act it guards — and zero rows deleted is a 409,
  // never a cheerful 200 reporting a deletion that did not happen.
  it("409s rather than deleting when the derivation was re-enabled underneath it", async () => {
    jest
      .mocked(loadDerivation)
      .mockResolvedValue({ record: record() } as never);
    const { db } = fakeDb(0);
    jest.mocked(requirePlanetscaleDb).mockReturnValue(db as never);

    const res = await del(true);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: { code: string } };
    expect(body.detail.code).toBe("derivation-enabled");
  });
});

describe("PATCH /api/v4/derivations/{dx_}", () => {
  // 🛑 The regression from PR 2's review: `boundary` is a run-detector slot, and an hws-model has
  // only `power` — so accepting this would delete its sole source row and write nothing back, and
  // the model would vanish from `listEnabledHwsModels` with a 200. Refused BEFORE any mutation.
  it("refuses boundaryPointUid on an hws-model, before touching the database", async () => {
    jest.mocked(loadDerivation).mockResolvedValue({
      record: record({ kind: "hws-model", role: null }),
    } as never);
    jest.mocked(requirePlanetscaleDb).mockImplementation(() => {
      throw new Error("must not be reached");
    });

    const res = await handlePatch(
      new NextRequest(`http://localhost/api/v4/derivations/${DXID}`, {
        method: "PATCH",
        body: JSON.stringify({ boundaryPointUid: null }),
      }),
      DXID,
    );
    expect(res.status).toBe(422);
  });

  // Identity is not patchable: `deriveDerivationId` is a uuidv5 over (source point, kind, role), so
  // "changing" one of those names a DIFFERENT derivation while leaving this row's id — and every
  // interval hanging off it — attached to the old meaning.
  it("refuses the identity fields, and `area` with them", async () => {
    jest
      .mocked(loadDerivation)
      .mockResolvedValue({ record: record() } as never);
    for (const field of ["kind", "role", "sourcePoints", "output", "area"]) {
      const res = await handlePatch(
        new NextRequest(`http://localhost/api/v4/derivations/${DXID}`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: "x" }),
        }),
        DXID,
      );
      expect(`${field}:${res.status}`).toBe(`${field}:422`);
    }
  });

  it("refuses an empty patch rather than stamping updatedAt for nothing", async () => {
    jest
      .mocked(loadDerivation)
      .mockResolvedValue({ record: record() } as never);
    const res = await handlePatch(
      new NextRequest(`http://localhost/api/v4/derivations/${DXID}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      DXID,
    );
    expect(res.status).toBe(422);
  });
});
