/**
 * ROUTE-level tests for `/api/v4/queue` — the ingest control plane's wire contract.
 *
 * Three things here are load-bearing rather than incidental:
 *
 * 1. **PATCH parallelism must PIN.** Every message we publish carries `flowControl.parallelism`, so
 *    an unpinned operator change is reverted by the very next poll — within ~60 s, mid-incident,
 *    silently. If this assertion ever goes green against a publish-option write, the lever is a lie.
 * 2. **A lane is required to set parallelism.** The pool ceiling is on the SUM across lanes, so one
 *    number applied fleet-wide is the accident this refuses. Pause/resume is not gated — "stop
 *    everything" is the one instruction that should not need qualifying.
 * 3. **The retired FIFO queue is never written.** It still exists on the QStash account until it is
 *    deleted, and a write that reached it would report success while changing nothing about what is
 *    actually delivered.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { NextRequest, NextResponse } from "next/server";
import type { FakeQstash } from "@/lib/observations/__tests__/fake-qstash";

jest.mock("@/lib/api-auth", () => ({ requireAdmin: jest.fn() }));
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: {} }));
jest.mock("@/lib/db/planetscale/schema", () => ({ observationsOutbox: {} }));
jest.mock("@/lib/readings", () => ({
  ReadingsDao: { latestIngestCreatedAtMs: jest.fn() },
}));
jest.mock("@/lib/qstash", () => {
  const actual = jest.requireActual("@/lib/qstash") as Record<string, unknown>;
  const { createFakeQstash } = jest.requireActual(
    "@/lib/observations/__tests__/fake-qstash",
  ) as typeof import("@/lib/observations/__tests__/fake-qstash");
  const instance = createFakeQstash();
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash =
    instance;
  return { ...actual, qstash: instance.client };
});

import { requireAdmin } from "@/lib/api-auth";
import { ReadingsDao } from "@/lib/readings";
import { observationsFlowKey } from "@/lib/qstash";
import { GET, PATCH } from "../queue/route";

const fake = () =>
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash;

const mockAuth = jest.mocked(requireAdmin);
const mockLatest = jest.mocked(ReadingsDao.latestIngestCreatedAtMs);

const LIVE = observationsFlowKey("live");
const BACKFILL = observationsFlowKey("backfill");

const flowState = (over: Record<string, number | boolean> = {}) => ({
  waitListSize: 0,
  parallelismMax: 5,
  parallelismCount: 0,
  isPaused: false,
  isPinnedParallelism: false,
  ...over,
});

const get = () =>
  GET(new NextRequest("http://localhost/api/v4/queue") as NextRequest);

const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/v4/queue", {
      method: "PATCH",
      body: JSON.stringify(body),
    }) as NextRequest,
  );

describe("/api/v4/queue", () => {
  const savedPool = process.env.PLANETSCALE_POOL_MAX;

  beforeEach(() => {
    mockAuth.mockReset();
    // `requireAdmin` returns a NextResponse to REJECT; anything else is the authorised caller.
    mockAuth.mockResolvedValue({ userId: "u_1" } as never);
    mockLatest.mockReset();
    mockLatest.mockResolvedValue(Date.now() - 12_000);
    fake().setFlow(LIVE, null);
    fake().setFlow(BACKFILL, null);
    fake().setQueue(null);
    fake().flowCalls.length = 0;
    fake().queueUpserts.length = 0;
    process.env.PLANETSCALE_POOL_MAX = "10";
  });

  afterEach(() => {
    if (savedPool === undefined) delete process.env.PLANETSCALE_POOL_MAX;
    else process.env.PLANETSCALE_POOL_MAX = savedPool;
  });

  it("passes an auth rejection straight through", async () => {
    mockAuth.mockResolvedValue(
      NextResponse.json({ error: "nope" }, { status: 403 }) as never,
    );
    expect((await get()).status).toBe(403);
  });

  it("GET renders every lane, including one QStash has never heard of", async () => {
    fake().setFlow(LIVE, flowState({ waitListSize: 4, parallelismCount: 2 }));

    const body = await (await get()).json();
    expect(body.lanes.map((l: { lane: string }) => l.lane)).toEqual([
      "live",
      "backfill",
    ]);
    // The backfill key does not exist in QStash — it must still be a row.
    expect(body.lanes[1]).toMatchObject({ idle: true, waiting: 0 });
    expect(body.waiting).toBe(4);
    expect(body.inFlight).toBe(2);
    expect(body.paused).toBe(false);
    expect(typeof body.stalledMinutes).toBe("number");
    expect(body.lastIngestedAt).toEqual(expect.any(String));
    // Retired at the 2026-09-10 cutover — a reader that still branches on these would be reading a
    // transport nothing publishes to.
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("legacyQueue");
  });

  it("PATCH parallelism PINS it, per lane", async () => {
    fake().setFlow(LIVE, flowState());
    fake().setFlow(BACKFILL, flowState({ parallelismMax: 2 }));

    const res = await patch({ lane: "backfill", parallelism: 1 });
    expect(res.status).toBe(200);
    expect(fake().flowCalls).toEqual([
      { op: "pin", key: BACKFILL, options: { parallelism: 1 } },
    ]);
    const body = await res.json();
    expect(body.lanes[1]).toMatchObject({ parallelism: 1, pinned: true });
  });

  it("PATCH parallelism: null unpins, handing control back to the publish option", async () => {
    fake().setFlow(LIVE, flowState({ isPinnedParallelism: true }));

    expect((await patch({ lane: "live", parallelism: null })).status).toBe(200);
    expect(fake().flowCalls).toEqual([
      { op: "unpin", key: LIVE, options: { parallelism: true } },
    ]);
  });

  it("refuses an unscoped parallelism write under flow control", async () => {
    const res = await patch({ parallelism: 3 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/lane must be one of/);
    expect(fake().flowCalls).toHaveLength(0);
  });

  it("validates parallelism against the SUM across lanes, not the lane alone", async () => {
    fake().setFlow(LIVE, flowState({ parallelismMax: 8 }));
    fake().setFlow(BACKFILL, flowState({ parallelismMax: 2 }));

    // 5 alone is under the pool of 10; 5 + 8 is not.
    const res = await patch({ lane: "backfill", parallelism: 5 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/SUM across lanes at 13/);
    expect(fake().flowCalls).toHaveLength(0);
  });

  it("pause with no lane means the whole path", async () => {
    fake().setFlow(LIVE, flowState());
    fake().setFlow(BACKFILL, flowState());

    const body = await (await patch({ paused: true })).json();
    expect(fake().flowCalls.map((c) => c.op)).toEqual(["pause", "pause"]);
    expect(body.pausedLanes).toEqual(["live", "backfill"]);
    expect(body.paused).toBe(true); // every lane paused
  });

  it("refuses a parallelism write that names no lane", async () => {
    // 🛑 The route is the enforcement point; the CLI's own refusal is a nicety on top. A cap set
    // fleet-wide is how one lane's number silently becomes the other's.
    fake().setFlow(LIVE, flowState());
    fake().setFlow(BACKFILL, flowState());

    const res = await patch({ parallelism: 5 });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/lane/);
    expect(fake().flowCalls).toHaveLength(0);
  });

  it("never writes the retired FIFO queue", async () => {
    // It still exists on the QStash account until it is deleted. A write that reached it would
    // report success and change nothing about what is actually being delivered.
    fake().setQueue({ paused: false, lag: 1053, parallelism: 5 });
    fake().setFlow(LIVE, flowState());
    fake().setFlow(BACKFILL, flowState());

    expect((await patch({ lane: "live", parallelism: 5 })).status).toBe(200);
    expect((await patch({ paused: true })).status).toBe(200);
    expect(fake().queueUpserts).toHaveLength(0);
  });

  it("rejects an empty or malformed body", async () => {
    expect((await patch({})).status).toBe(422);
    expect((await patch({ paused: "yes" })).status).toBe(422);
    expect((await patch({ lane: "nope", paused: true })).status).toBe(422);
  });
});
