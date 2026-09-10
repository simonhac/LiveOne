/**
 * Folding QStash's delivery log into per-batch timing.
 *
 * The fetch is separated from the fold precisely so this is testable without a network. What is
 * worth pinning is the distinction the module exists for: a batch that is SLOW and a batch that
 * fails FAST but burns its whole retry schedule both wedge a FIFO queue and look identical in
 * `lag`. If the fold blurs them it is worse than useless, because it would be believed.
 */
import { describe, it, expect } from "@jest/globals";
import { foldMessageLogs, summarise, type RawLog } from "../message-log";
// The flow key is BUILT, never spelled: its prefix is environment-dependent (`obs` in
// production, `obs-dev` elsewhere), so a literal would pass or fail on NODE_ENV.
import { OBSERVATIONS_QUEUE_NAME, observationsFlowKey } from "@/lib/qstash";

const T = 1_700_000_000_000;

const row = (
  over: Partial<RawLog> & { state: string; time: number },
): RawLog => ({
  messageId: "m1",
  queueName: OBSERVATIONS_QUEUE_NAME,
  ...over,
});

/** A message body as QStash carries it — base64 JSON. */
const body = (observations: number, extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      systemId: 10002,
      observations: Array.from({ length: observations }, () => ({})),
      ...extra,
    }),
  ).toString("base64");

describe("foldMessageLogs", () => {
  it("derives wait and duration from CREATED / ACTIVE / DELIVERED", () => {
    const { messages } = foldMessageLogs([
      row({ state: "CREATED", time: T, body: body(13) }),
      row({ state: "ACTIVE", time: T + 2_000 }),
      row({ state: "DELIVERED", time: T + 2_350 }),
    ]);
    expect(messages).toHaveLength(1);
    const [m] = messages;
    expect(m.waitMs).toBe(2_000);
    expect(m.durationMs).toBe(350);
    expect(m.occupancyMs).toBe(350);
    expect(m.attempts).toHaveLength(1);
    expect(m.observations).toBe(13);
    expect(m.settled).toBe(true);
  });

  it("separates a SLOW batch from one that fails fast and retries", () => {
    // 🛑 The whole point of the module. Both of these hold a FIFO slot for ~65s; only the first is
    // slow. Reporting one number for both is how "raise parallelism" got tried twice on a queue
    // whose problem was not throughput.
    const slow = foldMessageLogs([
      row({ messageId: "slow", state: "CREATED", time: T }),
      row({ messageId: "slow", state: "ACTIVE", time: T + 100 }),
      row({ messageId: "slow", state: "DELIVERED", time: T + 65_100 }),
    ]).messages[0];

    const fastFail = foldMessageLogs([
      row({ messageId: "poison", state: "CREATED", time: T }),
      row({ messageId: "poison", state: "ACTIVE", time: T + 100 }),
      row({ messageId: "poison", state: "RETRY", time: T + 400 }),
      row({ messageId: "poison", state: "ACTIVE", time: T + 5_400 }),
      row({ messageId: "poison", state: "RETRY", time: T + 5_700 }),
      row({ messageId: "poison", state: "ACTIVE", time: T + 20_700 }),
      row({ messageId: "poison", state: "ERROR", time: T + 21_000 }),
    ]).messages[0];

    expect(slow.durationMs).toBe(65_000);
    expect(slow.attempts).toHaveLength(1);

    // Each attempt is fast — under half a second — but the slot was held for 20.9s across three.
    expect(fastFail.durationMs).toBe(300);
    expect(fastFail.attempts).toHaveLength(3);
    expect(fastFail.attempts.every((a) => (a.durationMs ?? 0) < 500)).toBe(
      true,
    );
    expect(fastFail.occupancyMs).toBe(20_900);
  });

  it("leaves an unfinished attempt's duration null rather than zero", () => {
    // A window that ends mid-delivery. A 0 here would drag every percentile down and read as fast.
    const [m] = foldMessageLogs([
      row({ state: "CREATED", time: T }),
      row({ state: "ACTIVE", time: T + 500 }),
    ]).messages;
    expect(m.durationMs).toBeNull();
    expect(m.attempts[0].durationMs).toBeNull();
    expect(m.attempts[0].state).toBe("IN_PROGRESS");
    expect(m.settled).toBe(false);
  });

  it("leaves wait null when the window opened after the message was created", () => {
    const [m] = foldMessageLogs([
      row({ state: "ACTIVE", time: T }),
      row({ state: "DELIVERED", time: T + 200 }),
    ]).messages;
    expect(m.waitMs).toBeNull();
    expect(m.durationMs).toBe(200);
  });

  it("tolerates rows arriving out of order", () => {
    const [m] = foldMessageLogs([
      row({ state: "DELIVERED", time: T + 900 }),
      row({ state: "CREATED", time: T }),
      row({ state: "ACTIVE", time: T + 400 }),
    ]).messages;
    expect(m.waitMs).toBe(400);
    expect(m.durationMs).toBe(500);
  });

  it("counts rows from other traffic as foreign instead of inventing batches", () => {
    const { messages, foreign } = foldMessageLogs([
      row({ state: "CREATED", time: T }),
      row({ state: "DELIVERED", time: T + 10 }),
      { messageId: "other", state: "CREATED", time: T, queueName: "something" },
    ]);
    expect(messages).toHaveLength(1);
    expect(foreign).toBe(1);
  });

  it("classifies the transport, and never guesses a lane", () => {
    const { messages } = foldMessageLogs([
      // A pre-lane queue message: no flow key, no `lane` in the body.
      row({ messageId: "old", state: "CREATED", time: T, body: body(5) }),
      row({ messageId: "old", state: "DELIVERED", time: T + 5 }),
      // A flow-control message, keyed by lane.
      {
        messageId: "new",
        state: "CREATED",
        time: T + 1,
        flowControlKey: observationsFlowKey("backfill"),
        body: body(5, { lane: "backfill" }),
      },
      {
        messageId: "new",
        state: "DELIVERED",
        time: T + 6,
        flowControlKey: observationsFlowKey("backfill"),
      },
    ]);
    const old = messages.find((m) => m.messageId === "old")!;
    const fresh = messages.find((m) => m.messageId === "new")!;
    expect(old.transport).toBe("queue");
    expect(old.lane).toBeNull();
    expect(fresh.transport).toBe("flow");
    expect(fresh.lane).toBe("backfill");
  });

  it("orders newest first", () => {
    const { messages } = foldMessageLogs([
      row({ messageId: "a", state: "CREATED", time: T }),
      row({ messageId: "b", state: "CREATED", time: T + 5_000 }),
    ]);
    expect(messages.map((m) => m.messageId)).toEqual(["b", "a"]);
  });
});

describe("summarise", () => {
  const delivered = (id: string, wait: number, duration: number): RawLog[] => [
    row({ messageId: id, state: "CREATED", time: T }),
    row({ messageId: id, state: "ACTIVE", time: T + wait }),
    row({ messageId: id, state: "DELIVERED", time: T + wait + duration }),
  ];

  it("counts outcomes and retries", () => {
    const { messages } = foldMessageLogs([
      ...delivered("a", 10, 100),
      ...delivered("b", 10, 200),
      row({ messageId: "c", state: "CREATED", time: T }),
      row({ messageId: "c", state: "ACTIVE", time: T + 10 }),
      row({ messageId: "c", state: "RETRY", time: T + 20 }),
      row({ messageId: "c", state: "ACTIVE", time: T + 5_000 }),
      row({ messageId: "c", state: "ERROR", time: T + 5_010 }),
    ]);
    const s = summarise(messages);
    expect(s.messages).toBe(3);
    expect(s.delivered).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.inFlight).toBe(0);
    // One extra attempt on `c`. A non-zero here is the signature of retry-occupancy.
    expect(s.retries).toBe(1);
    expect(s.durationMs.max).toBe(200);
  });

  it("reports empty percentiles as null, never zero", () => {
    // A zero would read as "instant" on a dashboard. There is no measurement to report.
    const s = summarise([]);
    expect(s.durationMs).toEqual({ p50: null, p95: null, max: null });
    expect(s.messages).toBe(0);
  });

  it("excludes unfinished batches from the duration percentiles", () => {
    const { messages } = foldMessageLogs([
      ...delivered("done", 10, 400),
      row({ messageId: "running", state: "CREATED", time: T }),
      row({ messageId: "running", state: "ACTIVE", time: T + 10 }),
    ]);
    const s = summarise(messages);
    expect(s.messages).toBe(2);
    expect(s.inFlight).toBe(1);
    expect(s.durationMs).toEqual({ p50: 400, p95: 400, max: 400 });
  });
});
