import { describe, it, expect } from "@jest/globals";
import { faultLegOff, resolveFaultPoints } from "../diagnostics";
import type { FaultObservation } from "../diagnostics";

/** A readable Events page, with nothing wrong with it. */
const read = (over: Partial<FaultObservation> = {}): FaultObservation => ({
  ...faultLegOff(),
  state: "read",
  parseComplete: true,
  ...over,
});

describe("resolveFaultPoints", () => {
  it("publishes the vendor's ZERO on a device with the portal leg OFF", () => {
    // The default for every Selectronic device. This is the behaviour that predates the feature and
    // it must not change: a null would leave the last nonzero code standing as the latest value for
    // ever, so `50 → 0` would render as a permanent fault.
    expect(resolveFaultPoints(0, 0, faultLegOff())).toEqual({
      faultCode: 0,
      faultTsMs: 0,
    });
    expect(resolveFaultPoints(0, 1_758_100_000, faultLegOff())).toEqual({
      faultCode: 0,
      faultTsMs: 1_758_100_000_000,
    });
  });

  it("🛑 treats an ABSENT vendor field as unknown, not as a clearance", () => {
    // `numOrNull` yields null when select.live omits `fault_code`/`fault_ts` or sends something
    // unparseable. On a device with the portal leg off that is the only source there is, so the
    // answer is "write nothing and keep what we had" — the pre-existing adapter skipped the field
    // for exactly this reason. Publishing a zero here would clear a fault on no evidence.
    expect(resolveFaultPoints(null, null, faultLegOff())).toEqual({
      faultCode: null,
      faultTsMs: null,
    });
    expect(resolveFaultPoints(undefined, undefined, faultLegOff())).toEqual({
      faultCode: null,
      faultTsMs: null,
    });
    // A field that is present and zero still clears.
    expect(resolveFaultPoints(0, null, faultLegOff())).toEqual({
      faultCode: 0,
      faultTsMs: null,
    });
  });

  it("writes ZERO, not null, when a readable page shows no active fault", () => {
    expect(resolveFaultPoints(0, 0, read())).toEqual({
      faultCode: 0,
      faultTsMs: 0,
    });
  });

  it("prefers a fresh nonzero code from the readings over the portal", () => {
    expect(
      resolveFaultPoints(127, 1_758_100_000, read({ activeCode: 50 }))
        .faultCode,
    ).toBe(127);
  });

  it("falls back to the portal's active event when the readings report zero", () => {
    // The 17–18 September case exactly: every sampled fault_code was zero while the Events page
    // retained an active low-DC fault.
    const result = resolveFaultPoints(
      0,
      0,
      read({
        activeCode: 50,
        activeSince: new Date("2026-09-17T09:53:00Z"),
        lastFaultAt: new Date("2026-09-17T09:53:00Z"),
      }),
    );
    expect(result.faultCode).toBe(50);
    expect(result.faultTsMs).toBe(Date.parse("2026-09-17T09:53:00Z"));
  });

  it("does not manufacture a clearance when the Events page is UNAVAILABLE", () => {
    const result = resolveFaultPoints(0, 0, {
      ...faultLegOff(),
      state: "unavailable",
      reason: "HTTP 504",
    });
    expect(result.faultCode).toBeNull();
    expect(result.faultTsMs).toBeNull();
  });

  it("does not conclude ABSENCE from a partially readable page", () => {
    // If the row we could not parse was the active one, reading "no active fault" off the rest
    // would publish a clearance for a fault that is still live.
    const partial = read({ parseComplete: false, unreadableRows: 1 });
    expect(resolveFaultPoints(0, 0, partial).faultCode).toBeNull();
  });

  it("still trusts an active fault it DID see on a partial page", () => {
    const partial = read({
      parseComplete: false,
      unreadableRows: 1,
      activeCode: 50,
      lastFaultAt: new Date("2026-09-17T09:53:00Z"),
    });
    expect(resolveFaultPoints(0, 0, partial).faultCode).toBe(50);
  });

  it("converts the vendor's Unix SECONDS to the epoch MILLISECONDS the point declares", () => {
    // Fed through unconverted, as this did until the event work, every value landed in 1970.
    const seconds = 1_758_100_380;
    expect(resolveFaultPoints(50, seconds, faultLegOff()).faultTsMs).toBe(
      seconds * 1000,
    );
  });

  it("is STICKY: the last fault time survives the fault clearing", () => {
    const lastFaultAt = new Date("2026-09-17T09:53:00Z");
    const result = resolveFaultPoints(0, 0, read({ lastFaultAt }));
    // No active fault…
    expect(result.faultCode).toBe(0);
    // …but the occurrence is still reported, so a fault that came and went between two polls
    // leaves a trace.
    expect(result.faultTsMs).toBe(lastFaultAt.getTime());
  });

  it("takes the LATER of the two sources' fault times", () => {
    const older = new Date("2026-06-13T10:07:00Z");
    const newerSeconds = Math.floor(Date.parse("2026-09-17T09:53:00Z") / 1000);
    expect(
      resolveFaultPoints(0, newerSeconds, read({ lastFaultAt: older }))
        .faultTsMs,
    ).toBe(newerSeconds * 1000);
    expect(
      resolveFaultPoints(
        0,
        Math.floor(older.getTime() / 1000),
        read({ lastFaultAt: new Date("2026-09-17T09:53:00Z") }),
      ).faultTsMs,
    ).toBe(Date.parse("2026-09-17T09:53:00Z"));
  });
});
