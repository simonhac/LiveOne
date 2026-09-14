/**
 * `loadPointPool` must fail OPEN.
 *
 * 🛑 The regression this pins: `liveone area role list ar_01kv06sxtfe3199e5x5gyx50h6` (Craig
 * Unified) answered `error: Device not found`, exit 1. Two of its three members were
 * `status: "archived"`; an area aggregate returns its archived members on purpose
 * (`lib/areas/v4-shapes.ts` says so) while `GET /api/v4/devices/{id}` is `activeOnly`, so this loop
 * 404'd on the first retired member and took the whole verb down. An area whose devices had been
 * retired was unreportable by the one verb whose job is reporting its wiring — and the readable
 * two-thirds of the answer went with it.
 */
import { describe, it, expect, jest } from "@jest/globals";
import { CliFailure, EXIT } from "@/lib/cli/cli";
import { loadPointPool } from "../wiring/model";
import type { ApiSession } from "@/lib/cli-kit/api-session";

const members = [
  {
    id: "dv_live",
    name: "Craig Mondo",
    legacySystemId: 1,
    vendor: "sigenergy",
    status: "active",
  },
  {
    id: "dv_gone",
    name: "Craig Selectronic",
    legacySystemId: 2,
    vendor: "select.live",
    status: "archived",
  },
  {
    id: "dv_gone2",
    name: "Craig Enphase",
    legacySystemId: 3,
    vendor: "enphase",
    status: "archived",
  },
];

/** A session whose per-device GET 404s for anything in `missing`, as the real route does. */
function session(missing: string[], seen: string[] = []): ApiSession {
  return {
    origin: "https://example.test",
    token: "lo_cli_x",
    get: async (p: string) => {
      seen.push(p);
      const id = /devices\/([^?]+)/.exec(p)?.[1] ?? "";
      if (missing.includes(id))
        throw new CliFailure({
          code: EXIT.FINDINGS,
          what: "Device not found",
          why: "nothing at that address for this user",
          next: "list the objects of that kind",
        });
      return {
        name: `${id} name`,
        points: [
          {
            id: `pt_${id}`,
            logicalPath: "bidi.battery",
            metricType: "soc",
            unit: "%",
            name: "SoC",
          },
        ],
      };
    },
  } as unknown as ApiSession;
}

describe("loadPointPool", () => {
  it("asks for archived devices explicitly", async () => {
    const seen: string[] = [];
    await loadPointPool(session([], seen), members.slice(0, 1));
    // Both params matter: `include=points` or the pool is silently empty, `includeArchived` or a
    // retired member 404s.
    expect(seen[0]).toContain("include=points");
    expect(seen[0]).toContain("includeArchived=true");
  });

  it("keeps the readable members and NAMES the ones it lost", async () => {
    const pool = await loadPointPool(session(["dv_gone", "dv_gone2"]), members);
    expect(pool.points.map((p) => p.deviceId)).toEqual(["dv_live"]);
    expect(pool.unreadable).toEqual([
      {
        deviceId: "dv_gone",
        name: "Craig Selectronic",
        reason: "Device not found",
      },
      {
        deviceId: "dv_gone2",
        name: "Craig Enphase",
        reason: "Device not found",
      },
    ]);
  });

  it("returns an empty pool rather than throwing when EVERY member is unreadable", async () => {
    const pool = await loadPointPool(
      session(members.map((m) => m.id)),
      members,
    );
    expect(pool.points).toEqual([]);
    expect(pool.unreadable).toHaveLength(3);
  });

  /**
   * The original guard, unchanged in meaning: members that all answer 200 with NO points is a bug
   * in this loader (a dropped `?include=points`), not an area with nothing to bind. It must still
   * fire — the fix was to stop it firing when the emptiness was already explained.
   */
  it("still refuses when members answer fine but report no points at all", async () => {
    const s = {
      origin: "https://example.test",
      token: "t",
      get: async () => ({ name: "x", points: [] }),
    } as unknown as ApiSession;
    await expect(loadPointPool(s, members)).rejects.toMatchObject({
      detail: { what: expect.stringContaining("reported no points at all") },
    });
  });

  it("does nothing, and refuses nothing, for an area with no members", async () => {
    const pool = await loadPointPool(session([]), []);
    expect(pool).toEqual({ points: [], unreadable: [] });
  });
});

/**
 * 🛑 The destructive callers must fail CLOSED on the same failure the read paths tolerate.
 *
 * `loadPointPool` was changed to fail open so `area role list` could report an area whose members
 * are archived. `area devices remove|set` loads the SAME pool, but for the opposite purpose: to
 * name the bindings a shrink would destroy (`replaceMembers` deletes a departing member's bindings
 * server-side). A departing device whose points could not be read contributes nothing to that list,
 * so a fail-open pool turns "here is what you would lose" into a silent "0 bindings" — the exact
 * "reads as nothing to lose" trap the handler's own comment warns about, arriving as a clean run
 * instead of an error.
 */
describe("membershipWriter, against an unreadable departing device", () => {
  const AREA = "ar_x";

  async function run(argv: string[], missing: string[]) {
    const calls: { method: string; path: string }[] = [];
    jest.resetModules();
    jest.doMock("@/lib/cli-kit/api-session", () => ({
      withApiSession: async (
        _ctx: unknown,
        fn: (s: unknown) => Promise<number>,
      ) =>
        fn({
          origin: "https://example.test",
          token: "lo_cli_x",
          get: async (p: string) => {
            calls.push({ method: "GET", path: p });
            if (p === "/api/v4/areas")
              return { areas: [{ id: AREA, displayName: "Craig Unified" }] };
            if (p.startsWith("/api/v4/areas/"))
              return {
                area: { id: AREA, name: "Craig Unified" },
                members: members.map((m) => ({ ...m })),
                bindings: [],
              };
            if (p === "/api/v4/devices")
              return {
                devices: members.map((m) => ({ ...m, legacySystemId: 0 })),
              };
            const id = /devices\/([^?]+)/.exec(p)?.[1] ?? "";
            if (missing.includes(id))
              throw new CliFailure({
                code: EXIT.FINDINGS,
                what: "Device not found",
                why: "nothing at that address for this user",
                next: "list them",
              });
            return { name: id, points: [] };
          },
        }),
    }));
    jest.doMock("@/lib/cli-kit/http", () => ({
      apiFetch: async (_o: string, p: string, init: { method: string }) => {
        calls.push({ method: init.method, path: p });
        return { body: {} };
      },
    }));
    const { WIRING_HANDLERS } = await import("../wiring/handlers");
    const { areaCommand } = await import("../cli");
    const { parse } = await import("@/lib/cli/cli");
    const r = parse(
      areaCommand,
      argv,
      {
        stdoutIsTTY: true,
        stdinIsTTY: true,
      },
      ["liveone"],
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const ctx = {
      ...r,
      emit: () => {},
      note: () => {},
      warn: () => {},
      confirm: async () => true,
    };
    const key = r.subcommandPath.join(".");
    let error: { what?: string } | null = null;
    try {
      await WIRING_HANDLERS[key](ctx as never);
    } catch (e) {
      error = (e as { detail?: { what?: string } }).detail ?? null;
    }
    return { calls, error };
  }

  it("REFUSES to shrink membership when a departing device cannot be read", async () => {
    const { calls, error } = await run(
      ["devices", "remove", AREA, "dv_gone", "--apply", "--yes"],
      ["dv_gone"],
    );
    expect(error?.what).toMatch(/cannot enumerate what removing/);
    // and nothing was written
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("proceeds when the unreadable device is STAYING — its bindings are not at risk", async () => {
    const { error } = await run(
      ["devices", "remove", AREA, "dv_live", "--apply", "--yes"],
      ["dv_gone"],
    );
    expect(error).toBeNull();
  });
});
