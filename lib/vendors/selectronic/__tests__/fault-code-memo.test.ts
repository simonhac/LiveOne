import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("../portal-events", () => ({
  fetchAccountTimezone: jest.fn(),
  fetchPortalEvents: jest.fn(),
  summarisePortalEvents: jest.fn(),
}));
jest.mock("@/lib/diagnostics/store", () => ({
  ingestPortalEvents: jest.fn(),
  enqueueDiagnosticJob: jest.fn(),
}));

import { fetchAccountTimezone, fetchPortalEvents } from "../portal-events";
import {
  enqueueDiagnosticJob,
  ingestPortalEvents,
} from "@/lib/diagnostics/store";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { observePortalEvents, resetFaultCodeMemo } from "../diagnostics";
import type { DeviceConfigView } from "@/lib/registry/device-config";

const device = {
  id: 1,
  vendorSiteId: "1586",
  displayTimezone: "Australia/Melbourne",
  config: { diagnostics: { portalEvents: true, autoAcquire: true } },
} as unknown as DeviceConfigView;

const enqueue = jest.mocked(enqueueDiagnosticJob);
const ingest = jest.mocked(ingestPortalEvents);
const events = jest.mocked(fetchPortalEvents);
const tz = jest.mocked(fetchAccountTimezone);
const db = jest.mocked(requirePlanetscaleDb);
const executed: unknown[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  resetFaultCodeMemo();
  tz.mockResolvedValue("Australia/Melbourne");
  events.mockResolvedValue({
    available: true,
    events: [],
    timezone: "Australia/Melbourne",
    fetchedAt: new Date("2026-09-18T02:00:00Z"),
    unreadableRows: 0,
  });
  ingest.mockResolvedValue({
    inserted: 0,
    cleared: 0,
    baseline: false,
    reasons: [],
  });
  enqueue.mockResolvedValue({ jobId: "job-1", coalesced: false });
  // The transaction seam: run the callback with a stub handle. `execute` is the SET LOCAL
  // statement/lock timeouts, which bound the work server-side.
  executed.length = 0;
  db.mockReturnValue({
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({ execute: (q: unknown) => executed.push(q) }),
  } as never);
});

const observe = (code: number | null) =>
  observePortalEvents(device, {} as never, code);

describe("the polled fault_code trigger", () => {
  it("SEEDS on first sight without firing — a cold start is not a transition", async () => {
    // Otherwise a persistent fault would re-fire an acquisition on every process restart.
    await observe(127);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fires when the code moves from clear to a fault, within one process", async () => {
    await observe(0);
    await observe(127);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [, reasons] = enqueue.mock.calls[0];
    expect(reasons[0]).toMatchObject({
      kind: "fault-code-changed",
      detail: "polled fault_code 0 → 127",
    });
  });

  it("does not fire again while the same fault persists", async () => {
    await observe(0);
    await observe(127);
    await observe(127);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a CLEARANCE — the portal's Created/Cleared pair records that better", async () => {
    await observe(127);
    await observe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("fires when one fault is replaced by a different one", async () => {
    await observe(50);
    await observe(127);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1][0].detail).toBe(
      "polled fault_code 50 → 127",
    );
  });

  it("does not enqueue anything when autoAcquire is off", async () => {
    const readOnly = {
      ...device,
      config: { diagnostics: { portalEvents: true } },
    } as unknown as DeviceConfigView;
    await observePortalEvents(readOnly, {} as never, 0);
    await observePortalEvents(readOnly, {} as never, 127);
    expect(enqueue).not.toHaveBeenCalled();
    // …but the page is still RETAINED. Retention and acquisition are separate switches.
    expect(ingest).toHaveBeenCalledTimes(2);
  });

  it("bounds the retention transaction server-side, not just our wait on it", async () => {
    // `Promise.race` in the adapter stops us WAITING; it cannot cancel a query already executing or
    // release the connection it holds. SET LOCAL is what actually bounds the work.
    await observe(0);
    expect(executed).toHaveLength(2);
  });

  it("🛑 does NOT advance the memo when the portal request throws", async () => {
    // Otherwise the transition is consumed before it is durable: the next poll sees the same
    // nonzero code, computes no transition, and the acquisition never happens.
    await observe(0);
    events.mockRejectedValueOnce(new Error("boom"));
    const failed = await observe(127);
    expect(failed.state).toBe("unavailable");
    expect(enqueue).not.toHaveBeenCalled();
    // The very next poll re-detects the same transition and succeeds.
    await observe(127);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1][0].detail).toBe(
      "polled fault_code 0 → 127",
    );
  });

  it("still enqueues the code transition when the Events page is UNAVAILABLE", async () => {
    // The two sources fail independently, and the minute an inverter faults is exactly the minute
    // the portal is most likely to be unreachable.
    await observe(0);
    events.mockResolvedValueOnce({
      available: false,
      reason: "HTTP 504 from the Events page.",
      fetchedAt: new Date(),
    });
    const result = await observe(127);
    expect(result.state).toBe("unavailable");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1][0].kind).toBe("fault-code-changed");
    // …and having been enqueued, it is not repeated.
    await observe(127);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("treats a MISSING fault field as unknown, never as a transition", async () => {
    // `numOrNull` yields null when the vendor omits the field. Reading that as zero would both
    // fabricate a clearance and corrupt the memo for the next real transition.
    await observe(null);
    await observe(127);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
