import { describe, expect, it } from "@jest/globals";
import {
  assembleComparison,
  validateTrialPage,
  trialQuery,
} from "../trial-artifacts";
const pollerId = "11111111-1111-4111-8111-111111111111";
const pointId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const at = (minute: number) =>
  new Date(Date.parse("2026-01-01T00:00:00Z") + minute * 60000).toISOString();
function artifacts(energy = false) {
  const policy = {
    pollerId,
    pointId,
    deviceId,
    revision: 2,
    vendorSiteId: "site",
    referencePath: "solar",
    trialPath: "solar",
    metricType: energy ? "energy" : "power",
    unit: energy ? "Wh" : "W",
    transform: energy ? "d" : "n",
    start: at(0),
    end: at(5),
    windowMs: 300000,
    minimumCoverage: 1,
    absoluteTolerance: 1,
    relativeTolerance: 0,
    referenceCadenceMs: 60000,
    trialCadenceMs: 60000,
  };
  const common = {
    version: 1,
    pages: 2,
    pollerId,
    revision: 2,
    start: at(0),
    end: at(6),
    asOf: at(10),
  };
  const rows = Array.from({ length: 6 }, (_, i) => ({
    timestamp: at(i),
    value: energy ? i * 10 : 100,
    receivedTime: at(i + 0.1),
    createdAt: at(i + 0.2),
    error: null,
    dataQuality: "good",
    sessionId: `upload-${i}`,
  }));
  const base = {
    ...common,
    deviceId,
    values: "raw-untransformed",
    point: {
      id: pointId,
      physicalPath: "solar",
      metricType: policy.metricType,
      unit: policy.unit,
      transform: policy.transform,
    },
  };
  const reference = {
    complete: { ...common, pointId },
    pages: [
      { ...base, readings: rows.slice(0, 3), nextCursor: rows[2].timestamp },
      { ...base, readings: rows.slice(3), nextCursor: null },
    ],
  };
  const batches = rows.map((r, i) => ({
    id: String(i + 1).padStart(32, "0"),
    pollerId,
    revision: 2,
    vendorSiteId: "site",
    action: "store",
    sessionLabel: `gousher/upload-${i}`,
    measurementTime: r.timestamp,
    readings: [
      {
        physicalPathTail: "solar",
        metricType: policy.metricType,
        metricUnit: policy.unit,
        transform: policy.transform,
        value: r.value,
      },
    ],
  }));
  const trial = {
    complete: { ...common, vendorSiteId: "site" },
    pages: [
      {
        asOf: common.asOf,
        batches: batches.slice(0, 3),
        nextCursor: `${batches[2].id}.json`,
      },
      { asOf: common.asOf, batches: batches.slice(3), nextCursor: "" },
    ],
  };
  return { policy, reference, trial };
}
const run = (a: ReturnType<typeof artifacts>) =>
  assembleComparison(a.policy, a.reference, a.trial);
describe("retained export adapter", () => {
  it("compares complete paginated exports and retains unknown arrival lag", () => {
    const r = run(artifacts());
    expect(r.report.passed).toBe(true);
    expect(r.input.reference.samples).toHaveLength(6);
    expect(r.report.windows[0].trial.maximumArrivalLagMs).toBeNull();
  });
  it("compares cumulative energy across changing per-upload sessions", () => {
    const r = run(artifacts(true));
    expect(r.report.passed).toBe(true);
    expect(r.report.windows[0].trial.value).toBe(50);
  });
  it.each([
    "count",
    "continuation",
    "duplicate",
    "cutoff",
    "scope",
    "revision",
    "units",
    "path",
    "metadata",
  ])("rejects invalid %s evidence", (kind) => {
    const a = artifacts();
    if (kind === "count") a.trial.pages.pop();
    if (kind === "continuation") a.reference.pages[1].nextCursor = at(5);
    if (kind === "duplicate")
      a.trial.pages[1].batches[0].id = a.trial.pages[0].batches[2].id;
    if (kind === "cutoff") a.trial.pages[1].asOf = at(11);
    if (kind === "scope") a.trial.pages[1].batches[0].vendorSiteId = "other";
    if (kind === "revision") a.policy.revision = 3;
    if (kind === "units")
      a.trial.pages[1].batches[0].readings[0].metricUnit = "kW";
    if (kind === "path") a.policy.referencePath = "other";
    if (kind === "metadata") a.reference.pages[1].point.transform = "i";
    expect(() => run(a)).toThrow();
  });
  it("treats an omitted trial point as missing, not zero", () => {
    const a = artifacts();
    a.trial.pages[0].batches[1].readings = [];
    const r = run(a);
    expect(r.report.passed).toBe(false);
    expect(r.input.trial.samples[1].value).toBeNull();
    expect(r.report.windows[0].trial.coverage).toBe(0.8);
  });
  it("rejects duplicate physical paths instead of choosing one", () => {
    const a = artifacts();
    const readings = a.trial.pages[0].batches[0].readings;
    readings.push(readings[0]);
    expect(() => run(a)).toThrow(/Ambiguous/);
  });
  it("requires bounded query windows and a cursor naming the last returned batch", () => {
    const a = artifacts();
    const q = {
      pollerId,
      revision: 2,
      vendorSiteId: "site",
      start: at(0),
      end: at(6),
      asOf: at(10),
    };
    expect(
      trialQuery.safeParse({ ...q, end: at(61), asOf: at(62) }).success,
    ).toBe(false);
    a.trial.pages[0].nextCursor = "not-a-batch.json";
    expect(() => validateTrialPage(a.trial.pages[0], q)).toThrow(/cursor/);
  });
});
