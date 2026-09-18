import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/selectlive/transport", () => ({
  connect: jest.fn(),
  Portal: jest.fn(),
}));
jest.mock("@/lib/selectlive/protocol", () => ({
  // Spread the real module: `decodeEventRecord` reaches through to `wordsFrom`, and a mock that
  // omits it fails as a decoder error rather than as a missing mock.
  ...jest.requireActual<typeof import("@/lib/selectlive/protocol")>(
    "@/lib/selectlive/protocol",
  ),
  Inverter: jest.fn(),
  deviceInfo: jest.fn(),
}));
jest.mock("@/lib/selectlive/events", () => {
  const actual = jest.requireActual<typeof import("@/lib/selectlive/events")>(
    "@/lib/selectlive/events",
  );
  return {
    ...actual,
    acquireEventLog: jest.fn(),
    readScales: jest.fn(),
    readDeviceClock: jest.fn(),
  };
});
jest.mock("../store", () => ({
  insertCapture: jest.fn(),
  updateCapture: jest.fn(),
  resumeAnchors: jest.fn(),
  ingestInverterEvents: jest.fn(),
}));

import { connect, Portal } from "@/lib/selectlive/transport";
import { Inverter, deviceInfo } from "@/lib/selectlive/protocol";
import {
  acquireEventLog,
  readDeviceClock,
  readScales,
  EVENT_RECORD_WORDS,
} from "@/lib/selectlive/events";
import {
  ingestInverterEvents,
  insertCapture,
  resumeAnchors,
  updateCapture,
} from "../store";
import { acquireDiagnostics } from "../acquire";

const SERIAL = "221452";

/** One synthetic 36-word record, enough to be decodable. */
const record = (log: "alert" | "operational", seconds: number) => {
  const b = Buffer.alloc(EVENT_RECORD_WORDS * 2);
  b.writeUInt32LE(seconds, 0);
  b.writeUInt16LE(50, 4);
  b.writeUInt16LE(2200, 64);
  b.writeUInt16LE(12000, 68);
  return {
    log,
    address: 1000,
    hex: b.toString("hex"),
    deviceSeconds: seconds,
    deviceTime: "2026-09-18T12:00:00",
  };
};

const walk = (
  log: "alert" | "operational",
  over: Record<string, unknown> = {},
) => ({
  log,
  before: { recordCount: 1, entryWords: EVENT_RECORD_WORDS },
  after: null,
  records: [record(log, 800_000_000)],
  complete: true,
  metadataStable: true,
  newestAnchorStable: true,
  oldestAnchorStable: true,
  incremental: false,
  overlapObserved: false,
  overlapVerdict: "not-incremental",
  stoppedBecause: "exhausted",
  earliestDeviceTime: "2026-09-18T12:00:00",
  latestDeviceTime: "2026-09-18T12:00:00",
  ...over,
});

const updates = jest.mocked(updateCapture);
const anchorsIn = (call: number) =>
  Object.values(
    (
      updates.mock.calls[call]?.[1] as {
        coverage?: { logs?: Record<string, { anchor: unknown }> };
      }
    )?.coverage?.logs ?? {},
  ).map((l) => l.anchor);

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(connect).mockResolvedValue({} as never);
  jest.mocked(Portal).mockImplementation(
    () =>
      ({
        login: jest.fn(),
        select: jest.fn(),
        close: jest.fn(),
        channel: {},
      }) as never,
  );
  jest
    .mocked(Inverter)
    .mockImplementation(
      () => ({ login: jest.fn(), query: jest.fn() }) as never,
    );
  jest.mocked(deviceInfo).mockResolvedValue({
    serial: SERIAL,
    versions: { events: 3 },
  } as never);
  jest
    .mocked(readDeviceClock)
    .mockResolvedValue({ offsetSeconds: 46 } as never);
  jest.mocked(readScales).mockResolvedValue({
    acVoltage: 5300,
    acCurrent: 2200,
    dcVoltage: 1050,
    dcCurrent: 12000,
    temperature: 530,
    reserved: 180,
  } as never);
  jest.mocked(resumeAnchors).mockResolvedValue({});
  jest.mocked(insertCapture).mockResolvedValue("capture-1");
  jest.mocked(updateCapture).mockResolvedValue(undefined);
  jest.mocked(ingestInverterEvents).mockResolvedValue(2);
  jest
    .mocked(acquireEventLog)
    .mockImplementation(async (_r, log) => walk(log) as never);
});

const run = () =>
  acquireDiagnostics({
    deviceRid: 1,
    serial: SERIAL,
    portal: { email: "a@b.c", password: "x" },
    timezone: "Australia/Melbourne",
    reasons: [],
  });

describe("acquireDiagnostics — when an anchor may be published", () => {
  it("writes the bytes FIRST, with no anchor, then publishes anchors once ingested", async () => {
    const outcome = await run();
    expect(outcome.complete).toBe(true);
    expect(updates).toHaveBeenCalledTimes(2);
    // First write: raw present, complete false, no anchors.
    const first = updates.mock.calls[0][1] as Record<string, unknown>;
    expect(first.complete).toBe(false);
    expect(Array.isArray(first.raw)).toBe(true);
    expect(anchorsIn(0)).toEqual([null, null]);
    // Second write: complete, and both anchors now published.
    const second = updates.mock.calls[1][1] as Record<string, unknown>;
    expect(second.complete).toBe(true);
    expect(anchorsIn(1).every(Boolean)).toBe(true);
  });

  it("🛑 publishes NO anchor when the format cannot be decoded", async () => {
    // The walk completes and the bytes land, but nothing is ingested. An anchor here would make
    // every later acquisition skip records that are not in `device_events` and never will be —
    // including after decoder support is added.
    jest.mocked(deviceInfo).mockResolvedValue({
      serial: SERIAL,
      versions: { events: 4 },
    } as never);
    const outcome = await run();
    expect(ingestInverterEvents).not.toHaveBeenCalled();
    expect(outcome.complete).toBe(false);
    expect(anchorsIn(1)).toEqual([null, null]);
  });

  it("publishes NO anchor when ingestion fails", async () => {
    jest.mocked(ingestInverterEvents).mockRejectedValue(new Error("deadlock"));
    const outcome = await run();
    expect(outcome.complete).toBe(false);
    expect(outcome.error).toMatch(/deadlock/);
    // The last write records the failure and never carries an anchor.
    const last = updates.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(last.complete).toBe(false);
    expect(last.coverage).toBeUndefined();
  });

  it("🛑 is NOT complete when one log was truncated — but the OTHER keeps its anchor", async () => {
    // Per-log, deliberately. Ingestion is all-or-nothing across the capture, so a log whose own
    // walk completed has earned its anchor even though the capture has not. Withholding it because
    // the second log ran out of budget is how a retry gets stuck: it would re-read the first log in
    // full every time and truncate the second one again, until the ladder was exhausted.
    jest
      .mocked(acquireEventLog)
      .mockImplementation(async (_r, log) =>
        log === "alert"
          ? (walk("alert") as never)
          : (walk(log, { complete: false }) as never),
      );
    const outcome = await run();
    expect(outcome.complete).toBe(false);
    const logs = (
      updates.mock.calls[1][1] as {
        coverage: { logs: Record<string, { anchor: unknown }> };
      }
    ).coverage.logs;
    expect(logs.alert.anchor).not.toBeNull();
    expect(logs.operational.anchor).toBeNull();
  });
});
