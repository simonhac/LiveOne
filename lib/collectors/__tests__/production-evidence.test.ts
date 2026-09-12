import {
  summarizeProductionEvidence,
  measureProductionRead,
} from "../production-evidence";

it("uses measured read timing, never whole-session duration", () => {
  const start = new Date("2026-09-12T00:00:00Z"),
    end = new Date(+start + 900000);
  const rows = [
    {
      at: start,
      duration: 99999,
      response: {
        gousherTrialRead: {
          version: 1,
          source: "sigenergy",
          durationMs: 20,
          ok: true,
        },
      },
    },
    {
      at: new Date(+start + 1),
      duration: 99999,
      response: {
        gousherTrialRead: {
          version: 1,
          source: "sigenergy",
          durationMs: 200,
          ok: false,
          incident: "session-evicted",
        },
      },
    },
  ];
  expect(summarizeProductionEvidence("sigenergy", rows, start, end)).toEqual({
    metrics: { samples: 2, failureRate: 0.5, p95ReadMs: 200 },
    incidents: [{ at: rows[1].at.toISOString(), reason: "session-evicted" }],
  });
  expect(() =>
    summarizeProductionEvidence(
      "sigenergy",
      [{ at: start, response: {}, duration: 9999 }],
      start,
      end,
    ),
  ).toThrow();
});
it("measures failed fetches without replacing their errors", async () => {
  let evidence: unknown;
  const error = Object.assign(new Error("session lost"), { status: 401 });
  await expect(
    measureProductionRead(
      "sigenergy",
      async () => {
        throw error;
      },
      (e) => {
        evidence = e;
      },
    ),
  ).rejects.toBe(error);
  expect(evidence).toMatchObject({
    source: "sigenergy",
    ok: false,
    incident: "session-evicted",
  });
});
