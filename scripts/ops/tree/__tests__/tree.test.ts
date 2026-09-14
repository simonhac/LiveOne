import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { parse, type Ctx } from "@/lib/cli/cli";
import { renderTree } from "../render";
import { fixture } from "./fixture";

jest.mock("@/lib/cli-kit/api-session", () => ({ withApiSession: jest.fn() }));
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { treeCommand, runTree } from "../index";

describe("tree renderer", () => {
  it("shows the requested detail with cross-device references, history and sharing", () => {
    const output = renderTree(fixture(), { points: true, bindings: true });
    expect(output).toMatchSnapshot();
    expect(output.match(/Derivation: Charging sessions/g)).toHaveLength(1);
    expect(output).toContain("Derivation reference → Charging sessions");
    expect(output).toContain("[owner: craig@example.com]");
    expect(output).toContain("Owned device #2: EV → High Street");
    expect(output).toContain("[removed]");
    expect(output).toContain("[archived] [no devices in scope]");
    expect(output).toContain("No owner / public");
    expect(output).toContain("craig@example.com (viewer)");
    expect(output).toContain(
      "Interval provenance via High Street: 40 record(s)",
    );
  });
  it("keeps graph references when detail flags are off", () => {
    const output = renderTree(fixture(), { points: false, bindings: false });
    expect(output).toContain("Points: 1");
    expect(output).not.toContain("(pt_power)");
    expect(output).not.toContain("(bn_one)");
    expect(output).toContain("signal → Battery inverter / battery/power");
  });
  it("does not print sharing annotations when sharing was not requested", () => {
    const input = fixture();
    delete input.sharing;
    input.sharingIncluded = false;
    expect(renderTree(input, { points: false, bindings: false })).not.toContain(
      "Shared via",
    );
  });
  it("is stable when API collection order changes", () => {
    const a = fixture();
    const b = fixture();
    b.users.reverse();
    b.areas.reverse();
    b.devices.reverse();
    b.points.reverse();
    expect(renderTree(a, { points: true, bindings: true })).toBe(
      renderTree(b, { points: true, bindings: true }),
    );
  });
  it("makes terminal control characters inert", () => {
    const input = fixture();
    input.devices[0].name = "evil\nname\x1b[2J";
    const output = renderTree(input, { points: false, bindings: false });
    expect(output).not.toContain("\x1b");
    expect(output).toContain("evil name [2J");
  });
  it("retains a derivation with no devices", () => {
    const input = fixture();
    input.derivations[0].deviceIds = [];
    input.derivations[0].sources = [];
    expect(renderTree(input, { points: false, bindings: false })).toContain(
      "Unattached derivations",
    );
  });
});

describe("tree CLI", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it("accepts sharing and detail flags, and offers no mutation flags", () => {
    const tty = { stdinIsTTY: false, stdoutIsTTY: false };
    expect(
      parse(
        treeCommand,
        ["--sharing", "--points", "--bindings", "--admin"],
        tty,
      ).ok,
    ).toBe(true);
    expect(parse(treeCommand, ["--apply"], tty).ok).toBe(false);
  });
  it("uses only one authenticated GET and rejects a silently narrowed response", async () => {
    const get = jest
      .fn<(path: string) => Promise<unknown>>()
      .mockResolvedValue(fixture());
    jest
      .mocked(withApiSession)
      .mockImplementation(async (_ctx, fn) =>
        fn({ get, actingAsAdmin: true } as unknown as ApiSession),
      );
    const emit = jest.fn();
    const ctx = { flags: { sharing: true }, emit } as unknown as Ctx;
    expect(await runTree(ctx)).toBe(0);
    expect(get).toHaveBeenCalledWith("/api/v4/tree?sharing=true");
    expect(emit).toHaveBeenCalled();
    get.mockResolvedValue({ ...fixture(), scope: "own" });
    emit.mockClear();
    await expect(runTree(ctx)).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});
