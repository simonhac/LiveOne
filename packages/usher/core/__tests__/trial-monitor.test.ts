import { ProductionTrialMonitor, handleTrialExport } from "../trial-monitor";

describe("independent production trial feed", () => {
  it("reports only complete windows with failures and p95", () => {
    const start = Date.parse("2026-09-12T00:00:00Z");
    const m = new ProductionTrialMonitor(start);
    for (let i = 0; i < 20; i++)
      m.record("site", start + i * 1000, i === 0 ? 1000 : 10, i !== 0);
    expect(m.window("site", start + 900000, start + 899999)).toBeNull();
    expect(m.window("site", start + 900000, start + 900000)).toMatchObject({
      samples: 20,
      failureRate: 0.05,
      p95ReadMs: 10,
    });
    expect(m.window("missing", start + 900000, start + 900000)).toBeNull();
  });
  it("does not certify partial restart windows or overflow", () => {
    const start = Date.parse("2026-09-12T00:00:00Z");
    const m = new ProductionTrialMonitor(start + 1);
    m.record("site", start + 5, 10, true);
    expect(m.window("site", start + 900000, start + 900000)).toBeNull();
  });
  it("requires the dedicated bearer token", async () => {
    const old = process.env.USHER_TRIAL_MONITOR_TOKEN;
    process.env.USHER_TRIAL_MONITOR_TOKEN = "secret";
    try {
      expect(
        (
          await handleTrialExport(
            new Request("http://localhost/api/usher/trial?kind=window"),
          )
        ).status,
      ).toBe(401);
    } finally {
      if (old === undefined) delete process.env.USHER_TRIAL_MONITOR_TOKEN;
      else process.env.USHER_TRIAL_MONITOR_TOKEN = old;
    }
  });
});

it("rejects incident ranges whose events were evicted", () => {
  const start = Date.parse("2026-09-12T00:00:00Z"),
    m = new ProductionTrialMonitor(start);
  for (let i = 0; i < 1025; i++)
    m.record("site", start + i, 10, false, "connection-disruption");
  expect(m.events("site", start, start + 2000)).toBeNull();
  expect(m.events("missing", start, start + 2000)).toBeNull();
});
