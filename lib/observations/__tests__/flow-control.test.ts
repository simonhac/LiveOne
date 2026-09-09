/**
 * The ingest control plane's two load-bearing properties.
 *
 * 1. **A missing flow-control key renders as an IDLE LANE, never as an absent one.** Flow-control
 *    state is ephemeral: a key with nothing waiting, nothing in flight and no pin may not exist in
 *    QStash at all. Building the view from what QStash returns would render a TOTALLY STOPPED fleet
 *    as "0 lanes" and read as healthy — the same class of mistake as reading an empty DLQ as
 *    "nothing is wrong", which is exactly what happened for 2h20m on 2026-09-09.
 * 2. **`stuck` is the predicate the incident needed** — saturated AND backed up AND nothing landing.
 *    `lag` alone was misread as a throughput deficit twice; a busy path and a blocked one both grow.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import type { FakeQstash } from "./fake-qstash";

jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: {} }));
jest.mock("@/lib/db/planetscale/schema", () => ({ observationsOutbox: {} }));
jest.mock("@/lib/readings", () => ({
  ReadingsDao: { latestIngestCreatedAtMs: jest.fn() },
}));
jest.mock("@/lib/qstash", () => {
  const actual = jest.requireActual("@/lib/qstash") as Record<string, unknown>;
  const { createFakeQstash } = jest.requireActual(
    "./fake-qstash",
  ) as typeof import("./fake-qstash");
  const instance = createFakeQstash();
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash =
    instance;
  return { ...actual, qstash: instance.client };
});

import { ReadingsDao } from "@/lib/readings";
import { observationsFlowKey } from "@/lib/qstash";
import {
  readIngestState,
  readLanes,
  pinLaneParallelism,
  unpinLaneParallelism,
  INGEST_STALL_THRESHOLD_MIN,
} from "../flow-control";

const fake = () =>
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash;

const mockLatest = jest.mocked(ReadingsDao.latestIngestCreatedAtMs);

const LIVE = observationsFlowKey("live");
const BACKFILL = observationsFlowKey("backfill");

/** Minutes ago, as the epoch-ms the DAO would return. */
const minutesAgo = (m: number) => Date.now() - m * 60_000;

const flowState = (over: Partial<Record<string, number | boolean>> = {}) => ({
  waitListSize: 0,
  parallelismMax: 5,
  parallelismCount: 0,
  isPaused: false,
  isPinnedParallelism: false,
  ...over,
});

describe("the ingest control plane", () => {
  const savedMode = process.env.OBSERVATIONS_PUBLISH_MODE;

  beforeEach(() => {
    fake().setFlow(LIVE, null);
    fake().setFlow(BACKFILL, null);
    fake().setQueue(null);
    fake().flowCalls.length = 0;
    mockLatest.mockReset();
    mockLatest.mockResolvedValue(minutesAgo(0.2));
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.OBSERVATIONS_PUBLISH_MODE;
    else process.env.OBSERVATIONS_PUBLISH_MODE = savedMode;
  });

  it("renders a lane QStash has never heard of as idle, not as absent", async () => {
    const lanes = await readLanes();
    expect(lanes.map((l) => l.lane)).toEqual(["live", "backfill"]);
    expect(lanes.every((l) => l.idle)).toBe(true);
    // An idle lane reports the cap our NEXT publish would carry — an unpinned key's cap comes from
    // the message, so "what is it set to" has no other honest answer.
    expect(lanes.find((l) => l.lane === "live")?.parallelism).toBe(5);
    expect(lanes.find((l) => l.lane === "backfill")?.parallelism).toBe(2);
  });

  it("a total stop is not reported as an empty, healthy path", async () => {
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    mockLatest.mockResolvedValue(minutesAgo(140));

    const state = await readIngestState();
    // No keys exist at all — and yet the operator must still see two lanes and a stall.
    expect(state.lanes).toHaveLength(2);
    expect(state.stalled).toBe(true);
    expect(state.stalledMinutes).toBeGreaterThan(INGEST_STALL_THRESHOLD_MIN);
  });

  it("flags a lane stuck only when saturated AND backed up AND nothing is landing", async () => {
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    fake().setFlow(
      LIVE,
      flowState({ waitListSize: 1000, parallelismCount: 5, parallelismMax: 5 }),
    );

    // Saturated and backed up, but rows are still landing: busy, not blocked.
    mockLatest.mockResolvedValue(minutesAgo(0.2));
    expect((await readIngestState()).lanes[0].stuck).toBe(false);

    // Same queue shape, nothing landing: the 2026-09-09 signature.
    mockLatest.mockResolvedValue(minutesAgo(34));
    const stalled = await readIngestState();
    expect(stalled.lanes[0].stuck).toBe(true);
    expect(stalled.lanes[1].stuck).toBe(false); // idle lane, nothing waiting
  });

  it("summarises across lanes and exposes in-flight, which the queue could not", async () => {
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    fake().setFlow(
      LIVE,
      flowState({ waitListSize: 7, parallelismCount: 5, isPaused: true }),
    );
    fake().setFlow(
      BACKFILL,
      flowState({ waitListSize: 3, parallelismCount: 1, parallelismMax: 2 }),
    );

    const state = await readIngestState();
    expect(state.mode).toBe("flow");
    expect(state.waiting).toBe(10);
    expect(state.inFlight).toBe(6);
    expect(state.pausedLanes).toEqual(["live"]);
    expect(state.paused).toBe(false); // not EVERY lane is paused
    expect(state.lag).toBe(10); // compat alias
    expect(state.parallelism).toBe(5);
  });

  it("reports the LEGACY QUEUE while that is the transport actually in use", async () => {
    // The whole point of reading both: shipping the control plane before the cutover must not blind
    // it in the other direction. Lanes are empty here because nothing publishes to them yet.
    delete process.env.OBSERVATIONS_PUBLISH_MODE;
    fake().setQueue({ paused: true, lag: 1053, parallelism: 5 });

    const state = await readIngestState();
    expect(state.mode).toBe("queue");
    expect(state.waiting).toBe(1053);
    expect(state.paused).toBe(true);
    expect(state.parallelism).toBe(5);
    // The observability gap that made the incident invisible, stated rather than faked.
    expect(state.inFlight).toBeNull();
    expect(state.legacyQueue?.exists).toBe(true);
  });

  it("tolerates a queue that has never been created", async () => {
    delete process.env.OBSERVATIONS_PUBLISH_MODE;
    const state = await readIngestState();
    expect(state.legacyQueue?.exists).toBe(false);
    expect(state.waiting).toBe(0);
    expect(state.paused).toBe(false);
  });

  it("sets concurrency by PINNING it — an unpinned change is reverted by the next poll", async () => {
    await pinLaneParallelism("backfill", 1);
    expect(fake().flowCalls).toEqual([
      { op: "pin", key: BACKFILL, options: { parallelism: 1 } },
    ]);

    fake().flowCalls.length = 0;
    await unpinLaneParallelism("backfill");
    expect(fake().flowCalls).toEqual([
      { op: "unpin", key: BACKFILL, options: { parallelism: true } },
    ]);
  });

  it("an UNREADABLE lane renders as an error, never as a healthy idle one", async () => {
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    fake().setFlow(BACKFILL, flowState());
    // Not a 404 — an unexpected response. Throwing here would 500 the entire status view at the one
    // moment an operator needs it, so the lane degrades instead.
    fake().failFlowGet(LIVE, Object.assign(new Error("boom"), { status: 500 }));
    mockLatest.mockResolvedValue(minutesAgo(90));

    const state = await readIngestState();
    expect(state.lanes[0].error).toMatch(/boom/);
    expect(state.lanes[0].idle).toBe(false); // "could not see" ≠ "nothing here"
    // Zeros are the absence of a reading, not a measurement — so no stuck claim either way.
    expect(state.lanes[0].stuck).toBe(false);

    fake().failFlowGet(LIVE, null);
  });

  it("reports null lastIngestedAt without claiming a stall", async () => {
    mockLatest.mockResolvedValue(null);
    const state = await readIngestState();
    expect(state.lastIngestedAt).toBeNull();
    expect(state.stalledMinutes).toBeNull();
    expect(state.stalled).toBe(false);
  });
});
