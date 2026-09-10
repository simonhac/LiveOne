/**
 * Per-message DELIVERY TIMING for the observations ingest path.
 *
 * `flow-control.ts` answers "is ingest flowing"; this answers "how long does one batch take", which
 * is the question that was unanswerable on 2026-09-09 and the one that distinguishes the two ways a
 * FIFO queue wedges:
 *
 *   • a message that is genuinely SLOW holds its slot for the duration of the work, or
 *   • a message that fails FAST holds its slot for its whole RETRY SCHEDULE — because QStash
 *     delivers "waiting for the previous one to complete delivery **or exhaust retries**".
 *
 * Both look identical in `lag`. They are not the same defect and they do not have the same fix, and
 * the difference is visible only as `ACTIVE → terminal` per attempt.
 *
 * 🛑 **QStash already records this and we were discarding it.** `qstash.logs()` returns one row per
 * state transition (`CREATED → ACTIVE → DELIVERED | ERROR | RETRY | FAILED`) carrying `time`,
 * `messageId` and the body. `app/api/admin/observations/messages` has called it since the beginning
 * and uses it only to subtract terminated ids from created ones to list "pending" — every timestamp
 * needed for a duration was in hand and thrown away. This module pairs them instead.
 *
 * 🛑 **Retention is QStash's, not ours.** These logs age out on Upstash's schedule, so this is a
 * FORENSIC read, never a system of record. The durable equivalent is the receiver's own
 * `durationMs` log line (`app/api/observations/receive`), which survives both the retention window
 * and the retirement of the queue.
 *
 * See docs/plans/ingest-head-of-line-hardening.md.
 */

import {
  qstash,
  OBSERVATIONS_QUEUE_NAME,
  parseObservationsFlowKey,
} from "@/lib/qstash";
import { publishMode } from "./publish";
import type { ObservationLane, QueueMessage } from "./types";

/** One state transition, as QStash reports it. Narrowed to what a duration needs. */
export interface RawLog {
  messageId: string;
  time: number;
  state: string;
  url?: string;
  queueName?: string;
  flowControlKey?: string;
  body?: string;
  error?: string;
}

/** One delivery attempt: the span from being picked up to its outcome. */
interface Attempt {
  startedAt: number;
  endedAt: number | null;
  /** `null` while still IN_PROGRESS — an unfinished attempt has no duration yet, not a zero. */
  durationMs: number | null;
  state: string;
  error?: string;
}

/** One message's life, from publish to outcome. */
export interface MessageTiming {
  messageId: string;
  /** `null` for a pre-lane message, and for one we could not classify. Never guessed as `live`. */
  lane: ObservationLane | null;
  transport: "queue" | "flow" | "unknown";
  createdAt: number | null;
  /** `CREATED → first ACTIVE`. How long it sat behind other messages — the head-of-line measure. */
  waitMs: number | null;
  attempts: Attempt[];
  /** The last finished attempt's duration. The one to read for "how long does a batch take". */
  durationMs: number | null;
  /** Total time occupying a delivery slot, first pickup to last outcome — retries included. */
  occupancyMs: number | null;
  /** Latest state seen. Not necessarily terminal: a message may still be in flight. */
  state: string;
  settled: boolean;
  observations: number | null;
  systemId: number | null;
  error?: string;
}

interface Percentiles {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface MessageLog {
  window: { fromMs: number; toMs: number };
  /** Which transport is carrying messages NOW — for reading the mix below, not derived from it. */
  mode: "queue" | "flow";
  messages: MessageTiming[];
  summary: {
    messages: number;
    delivered: number;
    failed: number;
    inFlight: number;
    /** Attempts beyond the first, summed. Non-zero here is what retry-occupancy looks like. */
    retries: number;
    durationMs: Percentiles;
    waitMs: Percentiles;
    occupancyMs: Percentiles;
    byTransport: { queue: number; flow: number; unknown: number };
  };
  /**
   * True when the budget ran out before the window did.
   *
   * 🛑 Surfaced rather than swallowed: a truncated read under-reports every count, so a caller must
   * never conclude "quiet window" from it.
   */
  truncated: boolean;
  /**
   * The span actually READ — the oldest and newest log rows seen. `null` when nothing was.
   *
   * 🛑 Not the same as `window` once `truncated` is true. Paging walks backwards from the newest
   * row, so a truncated read holds the RECENT end of the requested window and silently omits the
   * old end. Reporting only `window` there would name a span we did not look at.
   */
  covered: { fromMs: number; toMs: number } | null;
  /** Log rows seen that belong to something other than observations ingest. */
  foreign: number;
}

const TERMINAL = new Set(["DELIVERED", "ERROR", "FAILED", "CANCELED"]);
const FAILED = new Set(["ERROR", "FAILED", "CANCELED"]);

/** Decode a QStash log body (base64 JSON) far enough to size the batch. Never throws. */
function peekBody(body: string | undefined): {
  observations: number | null;
  systemId: number | null;
  lane: ObservationLane | null;
} {
  const empty = { observations: null, systemId: null, lane: null };
  if (!body) return empty;
  try {
    const json = Buffer.from(body, "base64").toString("utf8");
    const parsed = JSON.parse(json) as QueueMessage;
    return {
      observations: parsed.observations?.length ?? null,
      systemId: typeof parsed.systemId === "number" ? parsed.systemId : null,
      // Absent on every pre-lane message. Left null rather than defaulted to `live`: this view
      // exists to explain an incident, and a guessed lane is worse than an honest blank.
      lane: parsed.lane ?? null,
    };
  } catch {
    return empty;
  }
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

/**
 * Fold raw state transitions into one row per message.
 *
 * PURE — the whole reason the fetch is separate. `logs` may arrive in any order and may be partial
 * at both ends of the window (a message created before it, or finishing after it), so nothing here
 * assumes a complete life: every derived span is `null` unless both of its endpoints were seen.
 */
export function foldMessageLogs(logs: RawLog[]): {
  messages: MessageTiming[];
  foreign: number;
} {
  const byMessage = new Map<string, RawLog[]>();
  let foreign = 0;

  for (const log of logs) {
    const flowLane = log.flowControlKey
      ? parseObservationsFlowKey(log.flowControlKey)
      : null;
    const ours = log.queueName === OBSERVATIONS_QUEUE_NAME || flowLane !== null;
    if (!ours) {
      foreign++;
      continue;
    }
    const rows = byMessage.get(log.messageId);
    if (rows) rows.push(log);
    else byMessage.set(log.messageId, [log]);
  }

  const messages: MessageTiming[] = [];
  for (const [messageId, rows] of byMessage) {
    rows.sort((a, b) => a.time - b.time);

    const created = rows.find((r) => r.state === "CREATED") ?? null;
    const body = peekBody(rows.find((r) => r.body)?.body);
    const withKey = rows.find((r) => r.flowControlKey || r.queueName);
    const flowLane = withKey?.flowControlKey
      ? parseObservationsFlowKey(withKey.flowControlKey)
      : null;
    const transport: MessageTiming["transport"] = flowLane
      ? "flow"
      : withKey?.queueName === OBSERVATIONS_QUEUE_NAME
        ? "queue"
        : "unknown";

    // Pair each ACTIVE with the next transition. A RETRY closes an attempt just as an ERROR does —
    // the slot was occupied either way, which is the number that matters for head-of-line.
    const attempts: Attempt[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].state !== "ACTIVE") continue;
      const next = rows.find(
        (r, j) => j > i && r.state !== "ACTIVE" && r.state !== "CREATED",
      );
      attempts.push({
        startedAt: rows[i].time,
        endedAt: next?.time ?? null,
        durationMs: next ? next.time - rows[i].time : null,
        state: next?.state ?? "IN_PROGRESS",
        ...(next?.error ? { error: next.error } : {}),
      });
    }

    const last = rows[rows.length - 1];
    const finished = attempts.filter((a) => a.durationMs !== null);
    const firstActive = attempts[0]?.startedAt ?? null;
    const lastEnd = finished[finished.length - 1]?.endedAt ?? null;

    messages.push({
      messageId,
      lane: flowLane ?? body.lane,
      transport,
      createdAt: created?.time ?? null,
      waitMs:
        created && firstActive !== null ? firstActive - created.time : null,
      attempts,
      durationMs: finished[finished.length - 1]?.durationMs ?? null,
      occupancyMs:
        firstActive !== null && lastEnd !== null ? lastEnd - firstActive : null,
      state: last.state,
      settled: TERMINAL.has(last.state),
      observations: body.observations,
      systemId: body.systemId,
      ...(rows.find((r) => r.error)?.error
        ? { error: rows.find((r) => r.error)!.error }
        : {}),
    });
  }

  // Newest first: an operator reading this during an incident wants the most recent batch on top.
  messages.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { messages, foreign };
}

/** Summarise folded messages. PURE. */
export function summarise(messages: MessageTiming[]): MessageLog["summary"] {
  const durations = messages
    .map((m) => m.durationMs)
    .filter((d): d is number => d !== null);
  const waits = messages
    .map((m) => m.waitMs)
    .filter((w): w is number => w !== null);
  const occupancies = messages
    .map((m) => m.occupancyMs)
    .filter((o): o is number => o !== null);
  return {
    messages: messages.length,
    delivered: messages.filter((m) => m.state === "DELIVERED").length,
    failed: messages.filter((m) => FAILED.has(m.state)).length,
    inFlight: messages.filter((m) => !m.settled).length,
    retries: messages.reduce(
      (n, m) => n + Math.max(0, m.attempts.length - 1),
      0,
    ),
    durationMs: percentiles(durations),
    waitMs: percentiles(waits),
    occupancyMs: percentiles(occupancies),
    byTransport: {
      queue: messages.filter((m) => m.transport === "queue").length,
      flow: messages.filter((m) => m.transport === "flow").length,
      unknown: messages.filter((m) => m.transport === "unknown").length,
    },
  };
}

/** Rows per QStash page. Its documented maximum; fewer pages is fewer round trips. */
const PAGE = 1000;
/**
 * How long the paging loop may run before giving up and reporting `truncated`.
 *
 * 🛑 The budget is WALL-CLOCK, not a page count. It was a page count first, and that is the wrong
 * unit: 20 pages is a fine bound on memory and no bound at all on time, so a dense window (the
 * 2026-09-09 incident at 2h50m) simply ran past the route's 60s `maxDuration` and returned a bare
 * 504 — the caller learned nothing, from a tool whose entire job is to answer during an incident.
 * A budget that ends in a partial answer marked `truncated` beats one that ends in no answer.
 *
 * 45s leaves the route ~15s to fold and serialise. One in-flight page can overrun it, which is why
 * it is not 55.
 *
 * Read per call, not at module load — the same posture as `observationRetries()` and friends in
 * `./publish`. A `const` here would bake in whatever the environment looked like at import time,
 * which is the trap that makes env-dependent behaviour untestable and, under `tsx`, sometimes wrong.
 */
function budgetMs(): number {
  return Number(process.env.QUEUE_TIMING_BUDGET_MS ?? 45_000);
}
/** Memory backstop, in the unit a page count IS good for. Time is the binding constraint. */
const MAX_PAGES = 40;

/**
 * Read the delivery log for a window.
 *
 * 🛑 The QStash query is filtered by TIME ONLY, and ownership is decided here. Filtering server-side
 * by `queueName`/`flowControlKey` would be cheaper and is the obvious thing to do — but it is the
 * same trap as enumerating flow-control keys: during the coexistence window our traffic is split
 * across two transports, and a filter that matches neither (a renamed queue, a changed prefix)
 * renders a busy path as an empty one. An over-fetch that reports `foreign` is recoverable; a
 * silently empty answer during an incident is not.
 */
export async function readMessageLog(opts: {
  fromMs: number;
  toMs?: number;
  lane?: ObservationLane;
}): Promise<MessageLog> {
  const toMs = opts.toMs ?? Date.now();
  const window = { fromMs: opts.fromMs, toMs };
  const mode = publishMode();
  if (!qstash) {
    return {
      window,
      mode,
      messages: [],
      summary: summarise([]),
      truncated: false,
      covered: null,
      foreign: 0,
    };
  }

  const raw: RawLog[] = [];
  let cursor: string | undefined;
  let truncated = false;
  const deadline = Date.now() + budgetMs();
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES || Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const res = await qstash.logs({
      count: PAGE,
      ...(cursor ? { cursor } : {}),
      filter: { fromDate: opts.fromMs, toDate: toMs },
    });
    raw.push(...((res.logs ?? []) as unknown as RawLog[]));
    if (!res.cursor) break;
    cursor = String(res.cursor);
  }

  const folded = foldMessageLogs(raw);
  const messages = opts.lane
    ? folded.messages.filter((m) => m.lane === opts.lane)
    : folded.messages;

  const times = raw.map((r) => r.time);
  return {
    window,
    mode,
    messages,
    summary: summarise(messages),
    truncated,
    // Spans every row READ, including foreign ones — it describes the read, not the result.
    covered: times.length
      ? { fromMs: Math.min(...times), toMs: Math.max(...times) }
      : null,
    foreign: folded.foreign,
  };
}
