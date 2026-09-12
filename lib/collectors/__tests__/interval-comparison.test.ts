import { describe, expect, it } from "@jest/globals";
import { compareIntervals } from "../interval-comparison";
const epoch = Date.parse("2026-01-01T00:00:00Z");
const time = (seconds: number) =>
  new Date(epoch + seconds * 1000).toISOString();
function input(shift = 0, metricType = "power") {
  const side = (offset: number) => ({
    deviceId: "explicit-device",
    physicalPath: "inverter/solar",
    metricType,
    unit: metricType === "energy" ? "Wh" : "W",
    transform: metricType === "energy" ? "d" : "n",
    cadenceMs: 60000,
    samples: Array.from({ length: 7 }, (_, i) => ({
      timestamp: time((i - 1) * 60 + offset),
      value: metricType === "energy" ? 1000 + i * 10 : 100,
      receivedTime: time((i - 1) * 60 + offset + 3),
      sessionId: "session",
    })),
  });
  return {
    start: time(0),
    end: time(300),
    windowMs: 300000,
    minimumCoverage: 1,
    absoluteTolerance: 1,
    relativeTolerance: 0.01,
    reference: side(0),
    trial: side(shift),
  };
}
describe("independent interval comparison", () => {
  it("compares shifted samples by cadence slots and reports arrival lag", () => {
    const result = compareIntervals(input(10));
    expect(result.passed).toBe(true);
    expect(result.windows[0].trial.coverage).toBe(1);
    expect(result.windows[0].trial.maximumArrivalLagMs).toBe(3000);
  });
  it("does not pass when both sides have no data", () => {
    const q = input();
    q.reference.samples = [];
    q.trial.samples = [];
    const r = compareIntervals(q);
    expect(r.passed).toBe(false);
    expect(r.windows[0].status).toBe("insufficient-evidence");
    expect(r.windows[0].reference.value).toBeNull();
  });
  it("flags gaps and duplicates separately from value differences", () => {
    const q = input();
    q.trial.samples.splice(2, 1);
    q.trial.samples.push(q.trial.samples[2]);
    const r = compareIntervals(q).windows[0];
    expect(r.trial.coverage).toBe(0.8);
    expect(r.trial.duplicates).toBe(1);
    expect(r.trial.maximumGapMs).toBe(120000);
    expect(r.status).toBe("insufficient-evidence");
  });
  it("reports numeric zero as observed data", () => {
    const q = input();
    for (const s of [q.reference, q.trial])
      s.samples.forEach((p) => (p.value = 0));
    expect(compareIntervals(q).passed).toBe(true);
  });
  it("reports out-of-tolerance values", () => {
    const q = input();
    q.trial.samples.forEach((p) => (p.value += 10));
    expect(compareIntervals(q).windows[0].status).toBe("difference");
  });
  it("rejects units and sign semantics that have not been normalized", () => {
    const q = input();
    q.trial.unit = "kW";
    expect(() => compareIntervals(q)).toThrow(/unit/);
    q.trial.unit = "W";
    q.trial.transform = "i";
    expect(() => compareIntervals(q)).toThrow(/Transform/);
  });
  it("uses common energy boundaries and ignores absolute counter baselines", () => {
    const q = input(10, "energy");
    q.trial.samples.forEach((p) => (p.value += 500));
    const r = compareIntervals(q);
    expect(r.passed).toBe(true);
    expect(r.windows[0].reference.value).toBe(50);
    expect(r.windows[0].trial.value).toBeCloseTo(50);
  });
  it("does not extrapolate energy at startup", () => {
    const q = input(10, "energy");
    q.trial.samples.shift();
    expect(compareIntervals(q).windows[0].trial.value).toBeNull();
  });
  it("flags counter and session resets", () => {
    const q = input(0, "energy");
    q.trial.samples[3].value = 0;
    expect(compareIntervals(q).windows[0].trial.reset).toBe(true);
    const q2 = input(0, "energy");
    q2.trial.samples[3].sessionId = "new-session";
    expect(compareIntervals(q2).passed).toBe(false);
  });
  it("rejects partial UTC windows and unverified energy increments", () => {
    const q = input();
    q.end = time(299);
    expect(() => compareIntervals(q)).toThrow(/aligned/);
    const energy = input(0, "energy");
    energy.reference.transform = energy.trial.transform = "n";
    expect(() => compareIntervals(energy)).toThrow(/semantics/);
  });
});
