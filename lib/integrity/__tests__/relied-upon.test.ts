import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));

import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { findDependents } from "../relied-upon";
import { Area } from "@/lib/ids";

/**
 * The finders, driven against a stub that returns what the DRIVER returns rather than what the
 * type annotation claims.
 *
 * That distinction is the whole point of this file. `sql<Date>` is a compile-time annotation on a
 * raw fragment — drizzle attaches no runtime decoder — so an aggregated `timestamp` arrives as
 * whatever node-postgres produced. The first version of `derivationDependents` called
 * `.toISOString()` on it directly and would have thrown the first time a derivation with any
 * history was examined. It typechecked, and no test saw it, because nothing drove the finder.
 */

/** A stub whose every builder method returns itself, resolving to the next queued result set. */
function stubDb(results: unknown[][]) {
  const queue = [...results];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "orderBy", "groupBy"])
    builder[m] = () => builder;
  // Drizzle's builders are thenables; awaiting one runs the query.
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(queue.shift() ?? []).then(resolve);
  return builder;
}

const mockDb = jest.mocked(requirePlanetscaleDb);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("derivation dependents", () => {
  const intervals = (first: unknown, last: unknown) => [
    [{ n: 3, first, last }], // the interval span
    [{ outputPointId: null }], // the derivation row
    [], // automations naming it
  ];

  it("reports the interval window when the driver returns STRINGS", async () => {
    // 🛑 The regression, twice over. Postgres hands back `2025-10-04 03:15:00` for min/max of a
    // timestamp while the annotation says Date, so `.toISOString()` on it throws — and once that is
    // fixed by casting, `new Date()` of a zoneless string parses it as LOCAL time, which on an AEST
    // machine reports the 3rd. Every timestamp in this database is naive UTC.
    mockDb.mockReturnValue(
      stubDb(intervals("2025-10-04 03:15:00", "2026-09-08 21:00:00")) as never,
    );
    const [dep] = await findDependents("derivation", "dx-uuid");
    expect(dep.kind).toBe("intervals");
    expect(dep.id).toBe("3");
    expect(dep.name).toBe("2025-10-04 … 2026-09-08");
    expect(dep.effect).toBe("cascade-deleted");
  });

  it("reports the same window when the driver returns Dates", async () => {
    mockDb.mockReturnValue(
      stubDb(
        intervals(
          new Date("2025-10-04T03:15:00Z"),
          new Date("2026-09-08T21:00:00Z"),
        ),
      ) as never,
    );
    const [dep] = await findDependents("derivation", "dx-uuid");
    expect(dep.name).toBe("2025-10-04 … 2026-09-08");
  });

  it("degrades to an unnamed window rather than throwing on rubbish", async () => {
    mockDb.mockReturnValue(stubDb(intervals("not a date", null)) as never);
    const [dep] = await findDependents("derivation", "dx-uuid");
    // A refusal message must never be the thing that 500s the request.
    expect(dep.id).toBe("3");
    expect(dep.name).toBeNull();
  });

  it("says nothing about intervals when there are none", async () => {
    mockDb.mockReturnValue(
      stubDb([
        [{ n: 0, first: null, last: null }],
        [{ outputPointId: null }],
        [],
      ]) as never,
    );
    expect(await findDependents("derivation", "dx-uuid")).toEqual([]);
  });
});

describe("automation dependents", () => {
  it("finds nothing today — and is called anyway, so the next reference has to be declared", async () => {
    mockDb.mockReturnValue(stubDb([]) as never);
    expect(await findDependents("automation", "au-uuid")).toEqual([]);
  });
});

describe("device dependents", () => {
  /** `deviceDependents` uses `innerJoin`, which the shared stub above does not carry. */
  function stubDeviceDb(results: unknown[][]) {
    const queue = [...results];
    const builder: Record<string, unknown> = {};
    for (const m of [
      "select",
      "from",
      "where",
      "limit",
      "orderBy",
      "groupBy",
      "innerJoin",
    ])
      builder[m] = () => builder;
    builder.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve);
    return builder;
  }

  const DEV = "01a0a00a-1dcb-7c7b-8580-fd59501666f5";
  const PT = "01a0a00a-1dcb-7c7b-8580-fd5950166600";

  /**
   * The destructive query order, so a test can queue results positionally:
   *   dashboards · own points · the device row · [area name] ·
   *   derivation sources · derivation outputs · area bindings · pollers · commands ·
   *   device events · diagnostic captures · diagnostic jobs · automations
   */
  const destructiveResults = (
    over: Partial<Record<string, unknown[]>> = {},
  ) => [
    over.dashboards ?? [],
    over.points ?? [{ id: PT, rid: 7, name: "p" }],
    over.device ?? [{ areaId: null, rid: 16 }],
    over.sources ?? [],
    over.outputs ?? [],
    over.bindings ?? [],
    over.pollers ?? [{ n: 0 }],
    over.commands ?? [{ n: 0 }],
    over.events ?? [{ n: 0 }],
    over.captures ?? [{ n: 0 }],
    over.jobs ?? [{ n: 0 }],
    over.automations ?? [],
  ];

  it("names the retained fault record, which no recompute rebuilds", async () => {
    // `device_events` / `diagnostic_captures` are EVIDENCE: the inverter's event ring is a few
    // hundred records deep and overwrites itself, so a capture is frequently the only surviving
    // account of an outage. A device delete has to say so rather than take them quietly.
    mockDb.mockReturnValue(
      stubDeviceDb(
        destructiveResults({
          events: [{ n: 412 }],
          captures: [{ n: 9 }],
          jobs: [{ n: 2 }],
        }),
      ) as never,
    );
    const deps = await findDependents("device", DEV, { destructive: true });
    const kinds = deps.map((d) => d.kind);
    expect(kinds).toContain("device-event");
    expect(kinds).toContain("diagnostic-capture");
    expect(kinds).toContain("diagnostic-job");
    expect(deps.find((d) => d.kind === "device-event")!.id).toBe(
      "412 record(s)",
    );
  });

  it("says nothing about the fault record when the device has none", async () => {
    mockDb.mockReturnValue(stubDeviceDb(destructiveResults()) as never);
    const deps = await findDependents("device", DEV, { destructive: true });
    expect(deps.map((d) => d.kind)).not.toContain("device-event");
  });

  it("🛑 refuses over an automation that names one of the device's points", async () => {
    // The regression this leg exists for. `ledger.ts` classified `automations.action.pointId` as
    // unprotected BECAUSE "a point is never deleted by a config path" — `hardDeleteDevice` made that
    // false, and without this scan the rule would be left dangling with nothing having refused.
    mockDb.mockReturnValue(
      stubDeviceDb(
        destructiveResults({
          automations: [
            {
              id: "01a0a00a-1dcb-7c7b-8580-fd59501666aa",
              name: "Charge overnight",
              trigger: {},
              action: { pointId: PT },
            },
          ],
        }),
      ) as never,
    );
    const deps = await findDependents("device", DEV, { destructive: true });
    expect(deps.map((d) => d.kind)).toContain("automation");
    expect(deps.find((d) => d.kind === "automation")!.via).toContain(
      "automations.trigger/.action",
    );
  });

  it("finds the trigger's two point paths, not just the action's", async () => {
    // `source.pointId` and the exercise trigger's nested `unless.loadPointId` — the census's own
    // comment calls the third reference "exactly the drift this exists to catch".
    for (const trigger of [
      { source: { pointId: PT } },
      { unless: { loadPointId: PT } },
    ]) {
      mockDb.mockReturnValue(
        stubDeviceDb(
          destructiveResults({
            automations: [
              {
                id: "01a0a00a-1dcb-7c7b-8580-fd59501666ab",
                name: "x",
                trigger,
                action: {},
              },
            ],
          }),
        ) as never,
      );
      const deps = await findDependents("device", DEV, { destructive: true });
      expect(deps.map((d) => d.kind)).toContain("automation");
    }
  });

  it("ignores an automation naming somebody else's point", async () => {
    mockDb.mockReturnValue(
      stubDeviceDb(
        destructiveResults({
          automations: [
            {
              id: "01a0a00a-1dcb-7c7b-8580-fd59501666ac",
              name: "other",
              trigger: { source: { pointId: "some-other-point" } },
              action: {},
            },
          ],
        }),
      ) as never,
    );
    const deps = await findDependents("device", DEV, { destructive: true });
    expect(deps.map((d) => d.kind)).not.toContain("automation");
  });

  it("the ARCHIVE question stops before the destructive legs", async () => {
    // Archiving destroys nothing, so the data legs must not be reported as obstacles to it —
    // otherwise archiving a device with any history would be impossible, which is every device.
    mockDb.mockReturnValue(
      stubDeviceDb([
        [],
        [{ id: PT, rid: 7, name: "p" }],
        [{ areaId: null, rid: 16 }],
      ]) as never,
    );
    const deps = await findDependents("device", DEV, { destructive: false });
    expect(deps).toEqual([]);
  });

  it("names the device's area membership, with the effect the scope implies", async () => {
    const withArea = (destructive: boolean) =>
      stubDeviceDb([
        [],
        [{ id: PT, rid: 7, name: "p" }],
        [{ areaId: "01a0a00a-1dcb-7c7b-8580-fd5950166611", rid: 16 }],
        [{ name: "Kutis" }],
        [],
        [],
        [],
        [{ n: 0 }],
        [{ n: 0 }],
        [],
      ]) as never;

    mockDb.mockReturnValue(withArea(false));
    const archive = await findDependents("device", DEV, { destructive: false });
    expect(archive.find((d) => d.kind === "area")!.effect).toBe(
      "silently-dropped",
    );

    mockDb.mockReturnValue(withArea(true));
    const del = await findDependents("device", DEV, { destructive: true });
    expect(del.find((d) => d.kind === "area")!.effect).toBe("cascade-deleted");
  });
});

describe("the area/helper deadlock", () => {
  /**
   * 🛑 The two carve-outs here exist because without them the lifecycles deadlocked: an area could
   * not be ARCHIVED while it held its own helper (and `ensureHelperDevice` re-homes the helper back,
   * so "remove it first" was advice that could not be followed), and the helper could not be
   * archived or deleted while it was in an area. Nothing could retire an area with battery
   * provenance, which is every area worth retiring.
   */
  const AREA = "01a0a00a-1dcb-7c7b-8580-fd5950166611";
  const HELPER = "01a0a00a-1dcb-7c7b-8580-fd59501666dd";
  const PT = "01a0a00a-1dcb-7c7b-8580-fd5950166600";

  function stubDeviceDb(results: unknown[][]) {
    const queue = [...results];
    const b: Record<string, unknown> = {};
    for (const m of [
      "select",
      "from",
      "where",
      "limit",
      "orderBy",
      "groupBy",
      "innerJoin",
    ])
      b[m] = () => b;
    b.then = (r: (v: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(r);
    return b;
  }

  it("an area's OWN helper does not block ARCHIVING it", async () => {
    // areaDependents order: dashboards · automations · members · [destructive legs…]
    mockDb.mockReturnValue(
      stubDb([
        [], // dashboards
        [], // automations
        [
          {
            id: HELPER,
            name: "Kutis · derived",
            vendor: "helper",
            vendorSiteId: `helper:area:${Area.encode(AREA)}`,
          },
        ],
      ]) as never,
    );
    const deps = await findDependents("area", AREA, { destructive: false });
    expect(deps).toEqual([]);
  });

  it("but it IS named on a DELETE, because it would be left dangling", async () => {
    mockDb.mockReturnValue(
      stubDb([
        [],
        [],
        [
          {
            id: HELPER,
            name: "Kutis · derived",
            vendor: "helper",
            vendorSiteId: `helper:area:${Area.encode(AREA)}`,
          },
        ],
        [], // orphan-helper leg
        [{ n: 0 }], // bindings
        [{ n: 0 }], // flow matrix
        [{ n: 0 }], // battery provenance
        [], // calendar tokens
        [{ n: 0 }], // interval provenance
        [], // user defaults
      ]) as never,
    );
    const deps = await findDependents("area", AREA, { destructive: true });
    const helper = deps.find((d) => d.kind === "helper-device");
    expect(helper).toBeDefined();
    expect(helper!.effect).toBe("dangles");
    // The fix must name a verb that EXISTS — "re-home it" was unfollowable.
    expect(helper!.fix).toContain("liveone device delete");
  });

  it("a NON-helper member still blocks an archive", async () => {
    // The carve-out is for the area's own server-managed helper, nothing wider.
    mockDb.mockReturnValue(
      stubDb([
        [],
        [],
        [
          {
            id: "01a0a00a-1dcb-7c7b-8580-fd59501666ee",
            name: "Kutis",
            vendor: "sigenergy",
            vendorSiteId: "102026062300090",
          },
        ],
      ]) as never,
    );
    const deps = await findDependents("area", AREA, { destructive: false });
    expect(deps.map((d) => d.kind)).toEqual(["device"]);
  });

  it("an ARCHIVED area does not block its device's archive or delete", async () => {
    // The other half of the deadlock. An archived area serves nothing, so "it would go quiet" is
    // already true and cannot be a reason to refuse.
    const rows = (status: string) => [
      [], // dashboards
      [{ id: PT, rid: 7, name: "p" }], // own points
      [{ areaId: AREA, rid: 16 }], // the device row
      [{ name: "Kutis", status }], // the area
      [],
      [],
      [],
      [{ n: 0 }],
      [{ n: 0 }],
      [], // destructive legs
    ];

    mockDb.mockReturnValue(stubDeviceDb(rows("archived")) as never);
    const archived = await findDependents("device", HELPER, {
      destructive: true,
    });
    expect(archived.map((d) => d.kind)).not.toContain("area");

    mockDb.mockReturnValue(stubDeviceDb(rows("active")) as never);
    const active = await findDependents("device", HELPER, {
      destructive: true,
    });
    expect(active.map((d) => d.kind)).toContain("area");
  });
});
