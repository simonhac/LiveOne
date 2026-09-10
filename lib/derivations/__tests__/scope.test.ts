/**
 * The authorization core of the derivations surface.
 *
 * These cases are the whole reason `derivations.area_id` could be dropped: the property that used
 * to be carried by "the area is in the WHERE clause" is now carried by "every device in the
 * derivation's own set must clear the check". That is not visible to tsc and it is not visible in a
 * smoke run against a single-operator fleet (one owner, everything owned) — the multi-owner cases
 * below are the only place it is exercised at all.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";

jest.mock("@/lib/api-auth", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requireAuth } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { Derivation } from "@/lib/ids";
import {
  authorizeRecord,
  listReadableDerivations,
  loadDerivation,
  requireWriteOnDevices,
  type DerivationRecord,
} from "../scope";

const ME = "user_me";
const THEM = "user_them";
const DX = "0199aaaa-0000-7000-8000-000000000001";
const MINE = "0199bbbb-0000-7000-8000-000000000001";
const THEIRS = "0199bbbb-0000-7000-8000-000000000002";
const PUBLIC = "0199bbbb-0000-7000-8000-000000000003";
const PT = "0199cccc-0000-7000-8000-000000000001";

const DEVICES = [
  { uuid: MINE, rid: 1, name: "Mine", ownerUserId: ME },
  { uuid: THEIRS, rid: 2, name: "Theirs", ownerUserId: THEM },
  { uuid: PUBLIC, rid: 3, name: "Public", ownerUserId: null },
];

/** A derivation row as `loadRecords`' join returns it: the parent, fanned out over its slots. */
function joinRows(
  deviceUuids: string[],
  overrides: Record<string, unknown> = {},
) {
  const d = {
    id: DX,
    kind: "run-detector",
    role: "generator",
    name: "generator runs",
    enabled: true,
    output: "intervals",
    outputPointId: null,
    params: {},
    sourcePoints: {},
    ...overrides,
  };
  if (deviceUuids.length === 0)
    return [
      {
        d,
        slot: null,
        pointId: null,
        sourceDeviceId: null,
        outputDeviceId: null,
      },
    ];
  return deviceUuids.map((deviceUuid, i) => ({
    d,
    slot: i === 0 ? "signal" : "energy",
    pointId: PT,
    sourceDeviceId: deviceUuid,
    outputDeviceId: null,
  }));
}

/**
 * A stand-in for the two reads `scope.ts` makes: the derivations join (`.leftJoin().leftJoin()`)
 * and the flat `devices` lookup. They are told apart by shape rather than by call order, so a test
 * cannot pass by accident when the query order changes.
 */
function fakeDb(rows: unknown[], deviceRows: unknown[] = DEVICES) {
  return {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ leftJoin: () => ({ where: async () => rows }) }),
        where: async () => deviceRows,
      }),
    }),
  };
}

/** The `devices` read as `requireWriteOnDevices` sees it: exactly the uuids it asked for. */
function devicesDb(uuids: string[]) {
  return fakeDb(
    [],
    DEVICES.filter((d) => uuids.includes(d.uuid)),
  );
}

function req() {
  return new NextRequest("http://localhost/api/v4/derivations/x");
}

function asUser(userId: string, isAdmin = false) {
  jest
    .mocked(requireAuth)
    .mockResolvedValue({ userId, isAdmin, isCron: false, isClaudeDev: false });
}

beforeEach(() => {
  jest.clearAllMocks();
  asUser(ME);
});

describe("loadDerivation", () => {
  it("resolves a derivation whose every device the caller owns", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb(joinRows([MINE])) as never);
    const out = await loadDerivation(req(), Derivation.encode(DX), "write");
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.record.devices.map((d) => d.rid)).toEqual([1]);
    expect(out.record.sources.map((s) => s.slot)).toEqual(["signal"]);
  });

  // 🛑 404, not 403. A 403 here would make the URL an existence oracle over `dx_` ids: ask for one,
  // learn whether it exists somewhere in the fleet.
  it("gives an unreadable derivation the same 404 as an unknown one", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb(joinRows([THEIRS])) as never);
    const out = await loadDerivation(req(), Derivation.encode(DX), "read");
    expect("error" in out && out.error.status).toBe(404);

    jest.mocked(requirePlanetscaleDb).mockReturnValue(fakeDb([]) as never);
    const missing = await loadDerivation(req(), Derivation.encode(DX), "read");
    expect("error" in missing && missing.error.status).toBe(404);
  });

  // 🛑 THE escalation case. One point of mine plus one of yours must not make a derivation I can
  // edit — "any device I can write" would be exactly that. It refuses at the READ step, so the
  // answer is the same 404 as for a row that does not exist: I cannot see it, so I am not told that
  // my own point is half of it.
  it("refuses a set that mixes my device with someone else's", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb(joinRows([MINE, THEIRS])) as never);
    const out = await loadDerivation(req(), Derivation.encode(DX), "write");
    expect("error" in out && out.error.status).toBe(404);
  });

  // The 403 leg: readable (a public device is readable by everyone) but not writable. This is the
  // only shape that reaches it, which is why it is worth pinning — the message has to NAME the
  // devices, because "403" over a three-device set is unactionable.
  it("names the devices that refused a write it could read", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb(joinRows([MINE, PUBLIC])) as never);
    const out = await loadDerivation(req(), Derivation.encode(DX), "write");
    expect("error" in out && out.error.status).toBe(403);
    if (!("error" in out)) return;
    const body = (await out.error.json()) as {
      detail: { devices: { name: string }[] };
    };
    expect(body.detail.devices.map((d) => d.name)).toEqual(["Public"]);
  });

  // An ownerless device is PUBLIC — readable by everyone, configurable by nobody but an admin. The
  // same split `requireDeviceAccess` makes between `canRead` and `canWrite`.
  it("lets anyone read an ownerless device's derivation, and nobody but an admin write it", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb(joinRows([PUBLIC])) as never);
    const read = await loadDerivation(req(), Derivation.encode(DX), "read");
    expect("error" in read).toBe(false);

    const write = await loadDerivation(req(), Derivation.encode(DX), "write");
    expect("error" in write && write.error.status).toBe(403);

    asUser("user_admin", true);
    const admin = await loadDerivation(req(), Derivation.encode(DX), "write");
    expect("error" in admin).toBe(false);
  });

  // 🛑 An empty set is "nothing to authorize against", not "no objections". Only reachable for a
  // derivation with no sources and no output point — a broken row, which an admin should still be
  // able to see and delete.
  it("fails closed on a derivation with no devices at all", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb(joinRows([])) as never);
    const out = await loadDerivation(req(), Derivation.encode(DX), "read");
    expect("error" in out && out.error.status).toBe(404);

    asUser("user_admin", true);
    const admin = await loadDerivation(req(), Derivation.encode(DX), "read");
    expect("error" in admin).toBe(false);
    if ("error" in admin) return;
    // It lists rather than disappearing — every join in `loadRecords` is LEFT for this reason.
    expect(admin.record.devices).toEqual([]);
  });

  it("400s a malformed id before touching the database", async () => {
    jest.mocked(requirePlanetscaleDb).mockImplementation(() => {
      throw new Error("must not be reached");
    });
    const out = await loadDerivation(req(), "dx_notanid", "read");
    expect("error" in out && out.error.status).toBe(400);
  });

  it("401s an unauthenticated caller", async () => {
    jest
      .mocked(requireAuth)
      .mockResolvedValue(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }) as never,
      );
    const out = await loadDerivation(req(), Derivation.encode(DX), "read");
    expect("error" in out && out.error.status).toBe(401);
  });
});

describe("authorizeRecord — the decision, without the HTTP", () => {
  const rec = (deviceUuids: string[]): DerivationRecord =>
    ({
      row: { id: DX },
      sources: [],
      devices: DEVICES.filter((d) => deviceUuids.includes(d.uuid)).map((d) => ({
        ...d,
        deviceId: `dv_${d.rid}`,
      })),
    }) as never;

  // 🛑 The hole this export exists to close (found in review). The CREATE path authorizes the
  // PROSPECTIVE device set — the points in the body — and `ensureRunDetector` is idempotent by
  // natural key, so `exists` can name a row whose set is WIDER. Alice POSTs her own signal point;
  // the existing detector also reads Bob's private energy point. Returning that row would disclose
  // through POST exactly what GET 404s for, so the record itself is re-authorized before it is
  // handed back.
  it("refuses a record whose set is wider than the one just authorized", () => {
    const refusal = authorizeRecord(rec([MINE, THEIRS]), ME, false, "write");
    expect(refusal?.status).toBe(404);
  });

  it("passes the record the create path actually authorized", () => {
    expect(authorizeRecord(rec([MINE]), ME, false, "write")).toBeNull();
  });

  // The refusal must not introduce the caller to a device they cannot see: name the visible ones,
  // COUNT the rest. Driven through a set that is readable (PUBLIC) but not writable, since that is
  // the only shape that reaches the 403.
  it("names only the devices the caller can see, and counts the rest", async () => {
    const refusal = authorizeRecord(rec([PUBLIC]), ME, false, "write");
    expect(refusal?.status).toBe(403);
    const body = (await refusal!.json()) as {
      detail: { devices: unknown[]; hiddenDevices?: number };
    };
    expect(body.detail.devices).toHaveLength(1);
    expect(body.detail.hiddenDevices).toBeUndefined();
  });
});

describe("requireWriteOnDevices — the create-path twin", () => {
  it("passes when every prospective device is the caller's", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(devicesDb([MINE]) as never);
    expect(await requireWriteOnDevices([MINE], ME, false)).toBeNull();
  });

  it("refuses a set that reaches onto someone else's device", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(devicesDb([MINE, THEIRS]) as never);
    const denied = await requireWriteOnDevices([MINE, THEIRS], ME, false);
    expect(denied?.status).toBe(403);
  });

  // The body reached a device the caller cannot even see (they named a `pt_` on it). The refusal
  // must not echo its id or name — "guess a point id, read back its owner's device" is a disclosure
  // oracle built out of an error message.
  it("withholds the identity of a device the caller cannot see", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(devicesDb([THEIRS]) as never);
    const denied = await requireWriteOnDevices([THEIRS], ME, false);
    expect(denied?.status).toBe(403);
    const body = (await denied!.json()) as {
      detail: { devices: unknown[]; hiddenDevices?: number };
    };
    expect(body.detail.devices).toEqual([]);
    expect(body.detail.hiddenDevices).toBe(1);
    expect(JSON.stringify(body)).not.toContain("Theirs");
  });

  // 🛑 A uuid with no `devices` row is a 422, never a silent drop from the set — dropping it would
  // turn "unknown device" into "no objection".
  it("refuses when a named device does not exist", async () => {
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(devicesDb([MINE]) as never);
    const denied = await requireWriteOnDevices(
      [MINE, "0199bbbb-0000-7000-8000-00000000000f"],
      ME,
      false,
    );
    expect(denied?.status).toBe(422);
  });

  // Daylesford's generator: signal on one device, energy on another, both the caller's. This is the
  // shape the all-devices rule must NOT refuse, and the one the smoke drives against prod.
  it("allows a detector spanning two devices the caller owns", async () => {
    jest.mocked(requirePlanetscaleDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: async () => [
            { uuid: MINE, rid: 1, name: "Mine", ownerUserId: ME },
            { uuid: PUBLIC, rid: 3, name: "Also mine", ownerUserId: ME },
          ],
        }),
      }),
    } as never);
    expect(await requireWriteOnDevices([MINE, PUBLIC], ME, false)).toBeNull();
  });

  it("refuses an empty set rather than treating it as unopposed", async () => {
    jest.mocked(requirePlanetscaleDb).mockReturnValue(devicesDb([]) as never);
    const denied = await requireWriteOnDevices([], ME, false);
    expect(denied?.status).toBe(422);
  });
});

describe("listReadableDerivations", () => {
  it("drops rows the caller could not have loaded individually", async () => {
    const mine = joinRows([MINE]);
    const theirs = joinRows([THEIRS], {
      id: "0199aaaa-0000-7000-8000-000000000002",
    });
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb([...mine, ...theirs]) as never);
    const rows = await listReadableDerivations(ME, false);
    expect(rows.map((r) => r.row.id)).toEqual([DX]);
  });

  it("narrows to a device without widening what is readable", async () => {
    const mine = joinRows([MINE]);
    const theirs = joinRows([THEIRS], {
      id: "0199aaaa-0000-7000-8000-000000000002",
    });
    jest
      .mocked(requirePlanetscaleDb)
      .mockReturnValue(fakeDb([...mine, ...theirs]) as never);
    // Naming someone else's device is an empty answer, never a 403 — the filter cannot be used to
    // discover what sits on it.
    expect(
      await listReadableDerivations(ME, false, { deviceUuid: THEIRS }),
    ).toEqual([]);
    expect(
      (await listReadableDerivations(ME, false, { deviceUuid: MINE })).length,
    ).toBe(1);
  });
});
