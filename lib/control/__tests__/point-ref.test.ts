import { describe, expect, it } from "@jest/globals";
import { Device, Point } from "@/lib/ids";
import { pointIdOf, teslaChargeControlTargets } from "@/lib/control/point-ref";

const PT = Point.generate();
const PT_SOC = Point.generate();
const PT_AMPS = Point.generate();

describe("pointIdOf", () => {
  const cases: Array<{
    name: string;
    latest: Record<string, { pointReference?: unknown } | null> | null;
    expected: string | null;
  }> = [
    {
      name: "a valid pt_ reference is returned as-is",
      latest: { "ev.charge/active": { pointReference: PT } },
      expected: PT,
    },
    {
      name: "the legacy '{systemId}.{pointIndex}' grammar is treated as ABSENT",
      latest: { "ev.charge/active": { pointReference: "9.7" } },
      expected: null,
    },
    {
      name: "a well-formed TypeID of the WRONG entity is absent",
      latest: { "ev.charge/active": { pointReference: Device.generate() } },
      expected: null,
    },
    {
      name: "a malformed string is absent",
      latest: { "ev.charge/active": { pointReference: "pt_not-base32!!" } },
      expected: null,
    },
    {
      name: "a missing path is absent",
      latest: { "ev.battery/soc": { pointReference: PT } },
      expected: null,
    },
    {
      name: "a null entry is absent",
      latest: { "ev.charge/active": null },
      expected: null,
    },
    {
      name: "an entry with no pointReference is absent",
      latest: { "ev.charge/active": {} },
      expected: null,
    },
    {
      name: "a non-string reference is absent",
      latest: { "ev.charge/active": { pointReference: 97 } },
      expected: null,
    },
    { name: "a null map is absent", latest: null, expected: null },
  ];

  for (const { name, latest, expected } of cases) {
    it(name, () => {
      expect(pointIdOf(latest, "ev.charge/active")).toBe(expected);
    });
  }

  it("an undefined map is absent", () => {
    expect(pointIdOf(undefined, "ev.charge/active")).toBeNull();
  });
});

describe("teslaChargeControlTargets", () => {
  it("resolves all three targets when all are present and valid", () => {
    expect(
      teslaChargeControlTargets({
        "ev.charge/active": { pointReference: PT },
        "ev.charge.limit/soc": { pointReference: PT_SOC },
        "ev.charge.limit/current": { pointReference: PT_AMPS },
      }),
    ).toEqual({ active: PT, limitSoc: PT_SOC, limitAmps: PT_AMPS });
  });

  it("the real post-deploy window: ev.charge/active has no KV entry yet", () => {
    // `ev.charge/active` is a NEW point — its latest entry does not exist until the device's
    // first poll on the post-deploy code. Start/Stop must disable, not post a guess.
    expect(
      teslaChargeControlTargets({
        "ev.charge.limit/soc": { pointReference: PT_SOC },
        "ev.charge.limit/current": { pointReference: PT_AMPS },
      }),
    ).toEqual({ active: null, limitSoc: PT_SOC, limitAmps: PT_AMPS });
  });

  it("a stale-KV map with only old-grammar references resolves nothing", () => {
    expect(
      teslaChargeControlTargets({
        "ev.charge/active": { pointReference: "10.3" },
        "ev.charge.limit/soc": { pointReference: "10.1" },
        "ev.charge.limit/current": { pointReference: "10.4" },
      }),
    ).toEqual({ active: null, limitSoc: null, limitAmps: null });
  });

  it("an empty map resolves nothing", () => {
    expect(teslaChargeControlTargets({})).toEqual({
      active: null,
      limitSoc: null,
      limitAmps: null,
    });
  });
});
