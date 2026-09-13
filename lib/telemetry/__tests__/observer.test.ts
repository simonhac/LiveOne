import { observeData, type ObservationTarget } from "../data-observer";
import {
  evaluateHealth,
  supervisorPolicy,
  queryReadEvidence,
  type SupervisorTarget,
} from "../supervisor";

const uuid = "11111111-1111-4111-8111-111111111111";
const target: ObservationTarget = {
  pollerId: uuid,
  revision: 1,
  deviceId: uuid,
  readerId: uuid,
  pointId: uuid,
  vendor: "sigenergy",
  cadenceSec: 300,
  liveSessionCauses: ["CRON"],
};
const now = Date.parse("2026-09-13T12:02:00Z");
function response(rows: unknown[], cursor: string | null = null) {
  return new Response(
    JSON.stringify({
      version: 1,
      deviceId: uuid,
      pollerId: uuid,
      revision: 1,
      start: "2026-09-13T11:45:00.000Z",
      end: new Date(now).toISOString(),
      asOf: new Date(now).toISOString(),
      values: "raw-untransformed",
      point: {
        id: uuid,
        physicalPath: "battery_soc",
        metricType: "soc",
        unit: "%",
        transform: "n",
      },
      readings: rows,
      nextCursor: cursor,
    }),
  );
}
function row(minute: number, extra = {}) {
  return {
    timestamp: `2026-09-13T11:${minute}:00.000000Z`,
    receivedTime: `2026-09-13T11:${minute}:30Z`,
    createdAt: `2026-09-13T11:${minute}:31Z`,
    value: 50,
    error: null,
    dataQuality: "good",
    sessionId: "opaque",
    sessionCause: "CRON",
    ...extra,
  };
}
it("counts slots, not bursts, and excludes repaired or historical observations", async () => {
  const request = jest
    .fn()
    .mockResolvedValue(
      response([
        row(45),
        row(46),
        row(50, { dataQuality: "calculated" }),
        row(55, { sessionCause: "BACKFILL" }),
      ]),
    );
  const data = await observeData(
    "https://liveone.example",
    "secret",
    target,
    now,
    120,
    request,
  );
  expect(data.coverage).toBe(1 / 3);
  expect(data.lastMeasurement).toBe(Date.parse("2026-09-13T11:46:00Z") / 1000);
  expect(request.mock.calls[0][1]).toMatchObject({
    redirect: "error",
    headers: { authorization: "Bearer secret" },
  });
});
it("does not turn zero into absent data", async () => {
  const data = await observeData(
    "https://liveone.example",
    "secret",
    target,
    now,
    120,
    jest.fn().mockResolvedValue(response([row(45, { value: 0 })])),
  );
  expect(data.coverage).toBe(1 / 3);
  expect(data.lastMeasurement).toBeDefined();
});
it("rejects failed pagination and changed identities without returning partial observations", async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(response([row(45)], row(45).timestamp))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  await expect(
    observeData("https://liveone.example", "secret", target, now, 120, request),
  ).rejects.toThrow("503");
  const altered = JSON.parse(await response([]).text());
  altered.deviceId = "22222222-2222-4222-8222-222222222222";
  await expect(
    observeData(
      "https://liveone.example",
      "secret",
      target,
      now,
      120,
      jest.fn().mockResolvedValue(new Response(JSON.stringify(altered))),
    ),
  ).rejects.toThrow("identity");
});
it("empty data is zero coverage and has no fabricated event timestamps", async () => {
  const data = await observeData(
    "https://liveone.example",
    "secret",
    target,
    now,
    120,
    jest.fn().mockResolvedValue(response([])),
  );
  expect(data.coverage).toBe(0);
  expect(data.lastMeasurement).toBeUndefined();
  expect(data.lastReceived).toBeUndefined();
});
const policyTarget: SupervisorTarget = {
  ...target,
  source: "t12345_test_metrics",
  service: "liveone",
  readCadenceSec: 300,
  statWindowSec: 7200,
  minimumSamples: 20,
  maxFailureRate: 0.01,
  maxP95Sec: 5,
  maxMetricAgeSec: 120,
  maxReadAgeSec: 600,
  maxDataAgeSec: 1200,
  minimumCoverage: 1,
};
function evidence(at = now / 1000) {
  return {
    data: {
      asOf: at,
      observedAt: at,
      windowEnd: Math.floor((at - 120) / 900) * 900,
      coverage: 1,
      lastMeasurement: at - 60,
      lastReceived: at - 30,
    },
    read: {
      asOf: at,
      metricAt: at - 30,
      lastSuccess: at - 60,
      samples: 24,
      failures: 0,
      p95Sec: 1,
      windowEnd: Math.floor((at - 120) / 7200) * 7200,
    },
  };
}
it("requires fresh upstream observations, enough samples and two distinct bad windows", () => {
  const at = now / 1000;
  const { data, read } = evidence();
  expect(evaluateHealth(policyTarget, data, read, undefined, at).healthy).toBe(
    true,
  );
  expect(
    evaluateHealth(policyTarget, data, { ...read, samples: 3 }, undefined, at)
      .healthy,
  ).toBe(false);
  expect(
    evaluateHealth(
      policyTarget,
      data,
      { ...read, metricAt: at - 121 },
      undefined,
      at,
    ).healthy,
  ).toBe(false);
  expect(
    evaluateHealth(
      policyTarget,
      data,
      { ...read, metricAt: at + 1 },
      undefined,
      at,
    ).healthy,
  ).toBe(false);
  const bad = { ...read, failures: 5 };
  const first = evaluateHealth(policyTarget, data, bad, undefined, at);
  expect(first.state.consecutive).toBe(1);
  expect(first.healthy).toBe(true);
  expect(
    evaluateHealth(policyTarget, data, bad, first.state, at).state.consecutive,
  ).toBe(1);
  const next = evidence(at + 7200);
  expect(
    evaluateHealth(
      policyTarget,
      next.data,
      { ...next.read, failures: 5 },
      first.state,
      at + 7200,
    ).healthy,
  ).toBe(false);
});
it("does not accept unverified backends, fictional baselines or impossible sample requirements", () => {
  const p = {
    version: 1,
    backendVerified: true,
    baselineStart: "2026-09-10T00:00:00Z",
    baselineEnd: "2026-09-12T00:00:00Z",
    targets: [policyTarget],
  };
  expect(supervisorPolicy.safeParse(p).success).toBe(true);
  expect(
    supervisorPolicy.safeParse({ ...p, backendVerified: false }).success,
  ).toBe(false);
  expect(
    supervisorPolicy.safeParse({
      ...p,
      targets: [{ ...policyTarget, statWindowSec: 900 }],
    }).success,
  ).toBe(false);
});
it("bounds and scopes Better Stack queries and rejects injection before sending", async () => {
  const request = jest
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ samples: "24", failures: "0", p95Sec: 1 }] }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: ["last_started", "last_completed", "last_success"].map(
            (name) => ({
              name: `liveone.read.${name}`,
              value: now / 1000 - 60,
              observedAt: now / 1000 - 30,
            }),
          ),
        }),
      ),
    );
  const read = await queryReadEvidence(
    "https://query.example",
    "user",
    "password",
    policyTarget,
    now,
    request,
  );
  expect(read.samples).toBe(24);
  expect(request.mock.calls[0][1].body).toContain(
    "label('environment') = 'production'",
  );
  await expect(
    queryReadEvidence(
      "https://query.example",
      "u",
      "p",
      { ...policyTarget, source: "x); DROP TABLE x" },
      now,
      request,
    ),
  ).rejects.toThrow("identity");
  expect(request).toHaveBeenCalledTimes(2);
});

it("uses one observation cutoff across window rollover and rejects stale/future state", () => {
  const at = now / 1000;
  const { data, read } = evidence(at);
  expect(
    evaluateHealth(policyTarget, data, read, undefined, at + 10).healthy,
  ).toBe(true);
  expect(
    evaluateHealth(policyTarget, data, read, undefined, at + 61).healthy,
  ).toBe(false);
  expect(
    evaluateHealth(
      policyTarget,
      data,
      read,
      { end: read.windowEnd + 7200, consecutive: 0 },
      at,
    ).healthy,
  ).toBe(false);
});
