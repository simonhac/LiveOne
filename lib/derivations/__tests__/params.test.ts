import { describe, expect, it } from "@jest/globals";
import { mergeDetectConfig } from "@/lib/derivations/params";
import type { RunDetectorParams } from "@/lib/derivations/resolve";

const base: RunDetectorParams = { signalKind: "power-threshold", lowerW: -50 };

describe("mergeDetectConfig", () => {
  it("inherits the per-role defaults for every absent key", () => {
    expect(mergeDetectConfig(base, "generator")).toEqual({
      lowerW: -50,
      upperW: null,
      hysteresisW: 0,
      delayOnMs: 0,
      delayOffMs: 120_000,
      boundaryMode: "edge",
    });
  });

  it("falls back to the generic defaults for a role with none of its own", () => {
    const cfg = mergeDetectConfig({ ...base }, "pump");
    expect(cfg.delayOnMs).toBe(30_000); // generic, not the generator's 0
    expect(cfg.delayOffMs).toBe(120_000);
  });

  it("gives ev its own defaults — NOT the generic ones it would otherwise inherit", () => {
    // The regression this guards: `ev` is a role the registry has always known, so before it got an
    // entry in DEFAULTS_BY_ROLE it silently took GENERIC_DEFAULTS — a 120s delay_off on a 120s-cadence
    // meter, which is the knife edge that fragments a run on one missed poll.
    const cfg = mergeDetectConfig(
      { signalKind: "power-threshold", upperW: 100 },
      "ev",
    );
    expect(cfg).toEqual({
      lowerW: null,
      upperW: 100,
      hysteresisW: 0,
      delayOnMs: 0,
      delayOffMs: 300_000,
      boundaryMode: "midpoint",
    });
  });

  it("midpoint boundaries are ev's, not everyone's", () => {
    expect(mergeDetectConfig(base, "generator").boundaryMode).toBe("edge");
    expect(mergeDetectConfig(base, "pump").boundaryMode).toBe("edge");
  });

  it("lets explicit params win over the defaults", () => {
    const cfg = mergeDetectConfig(
      { ...base, hysteresisW: 25, delayOnSeconds: 45, delayOffSeconds: 90 },
      "generator",
    );
    expect(cfg.hysteresisW).toBe(25);
    expect(cfg.delayOnMs).toBe(45_000);
    expect(cfg.delayOffMs).toBe(90_000);
  });

  it("treats an explicit 0 as configured, not absent", () => {
    // The bug this guards: `params.delayOffSeconds || default` would silently restore 120s.
    const cfg = mergeDetectConfig(
      { ...base, delayOffSeconds: 0, hysteresisW: 0 },
      "generator",
    );
    expect(cfg.delayOffMs).toBe(0);
    expect(cfg.hysteresisW).toBe(0);
  });

  it("carries both threshold bounds through, defaulting each to null", () => {
    expect(
      mergeDetectConfig({ signalKind: "power-threshold" }, "generator"),
    ).toMatchObject({ lowerW: null, upperW: null });
    expect(
      mergeDetectConfig(
        { signalKind: "power-threshold", upperW: 500 },
        "generator",
      ),
    ).toMatchObject({ lowerW: null, upperW: 500 });
  });

  it("always takes boundaryMode from code — it was never a column", () => {
    const cfg = mergeDetectConfig(
      { ...base, ...({ boundaryMode: "midpoint" } as object) },
      "generator",
    );
    expect(cfg.boundaryMode).toBe("edge");
  });
});
