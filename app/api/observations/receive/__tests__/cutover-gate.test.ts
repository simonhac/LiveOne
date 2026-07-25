/**
 * The cutover gate on the receiver — defect D-h.
 *
 * The window's step 1 pauses the QStash queue, but that is an operator action against a third-party
 * console and does not cover messages already in flight. The `cutover:paused` KV flag alone does NOT
 * help either: it gates only the six cron routes that call `cutoverSkipReason`, never this route.
 *
 * A single write that slips through lands during stage 4's ~6-minute copy, which runs over a
 * `[min(id), max(id)]` range captured once at the start — so the row is silently NOT copied. It ends up
 * in `point_readings_old` and is gone, on the irreversible side of the window.
 *
 * Two properties matter and are both pinned here: the gate REFUSES while paused, and it refuses with a
 * RETRYABLE status. Acking (2xx) would drop the data permanently — the outbox row for the message is
 * already marked published, so nothing would ever re-publish it.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import type { NextRequest } from "next/server";

const cutoverPausedForIngest = jest.fn<() => Promise<boolean>>();

// Identity-wrap the signature verifier: it 503s without a signing key, which would mask the handler.
jest.mock("@/lib/observations/qstash-receiver", () => ({
  withQstashSignatureVerification: (h: unknown) => h,
}));
jest.mock("@/lib/cron/guard", () => ({
  cutoverPausedForIngest: () => cutoverPausedForIngest(),
  CUTOVER_PAUSED_KEY: "cutover:paused",
}));
jest.mock("@/lib/kv", () => ({
  kvKey: (p: string) => `test:${p}`,
  kv: { get: async () => null },
}));
// Unconfigured Postgres → the handler's own 500 branch. That is the control: it proves the request
// reached the handler, so a refusal under the gate is the GATE's refusal and not an import-time failure.
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));

const req = () =>
  ({
    json: async () => ({ systemId: 1, batchTime: "2026-01-01T00:00:00Z" }),
  }) as unknown as NextRequest;

describe("observations receiver — cutover gate", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("refuses with a RETRYABLE 5xx while the cutover flag is set", async () => {
    cutoverPausedForIngest.mockResolvedValue(true);
    const { POST } = await import("../route");
    const res = await POST(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    await expect(res.json()).resolves.toMatchObject({
      error: "cutover_paused",
    });
  });

  it("never acks (2xx) while paused — an ack would drop the reading permanently", async () => {
    cutoverPausedForIngest.mockResolvedValue(true);
    const { POST } = await import("../route");
    expect((await POST(req())).status).not.toBeLessThan(300);
  });

  it("falls through to the handler when the flag is clear", async () => {
    cutoverPausedForIngest.mockResolvedValue(false);
    const { POST } = await import("../route");
    const res = await POST(req());
    // Reaches the Postgres-not-configured branch, i.e. past the gate — a different 500 with a different
    // body. If this asserted only on the status it could not tell the two refusals apart.
    await expect(res.json()).resolves.toMatchObject({
      error: "planetscale_not_configured",
    });
  });
});
