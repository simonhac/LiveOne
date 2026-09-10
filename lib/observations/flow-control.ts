/**
 * The observations ingest CONTROL PLANE — one aggregation, three readers.
 *
 * `/api/v4/queue`, `app/api/cron/monitor-observations` and `scripts/qstash-health.ts` all need the
 * same answer to "is ingest flowing, and if not, why". Before this module each of them asked QStash
 * its own slightly different question, which is how the 2026-09-09 outage stayed invisible for
 * 2h20m: the queue said `lag` (ambiguous), the DLQ said 0 (empty for the whole outage), and nothing
 * said what was *in flight*. `readIngestState()` is the single answer, and `stuck` is the predicate
 * that would have been true from minute one.
 *
 * 🛑 **Never build the lane view from what QStash returns.** A flow-control key with nothing in
 * flight, nothing waiting and no pin may not exist at all — flow-control state is ephemeral, unlike
 * a Queue, which persists once created. Enumerating "the keys QStash knows about" would render a
 * TOTALLY STOPPED fleet as "0 lanes" and read as healthy. So we enumerate `OBSERVATION_LANES` and
 * left-join, rendering a missing key as `idle`.
 *
 * 🛑 **A lane that reads clean is not proof that publishing works.** `flowControl.get()` answers
 * 200 for a key `publishJSON` would reject outright, which is how the 2026-09-10 cutover reported
 * two healthy lanes while nothing at all was being published. `stalledMinutes` and
 * `liveone queue outbox` are the checks that see through that; the lane numbers alone are not.
 *
 * See docs/plans/ingest-head-of-line-hardening.md.
 */

import { qstash, observationsFlowKey } from "@/lib/qstash";
import { ReadingsDao } from "@/lib/readings";
import { planetscaleDb } from "@/lib/db/planetscale";
import { OBSERVATION_LANES, type ObservationLane } from "./types";
import { laneParallelism } from "./publish";

/**
 * Minutes without a durable write before ingest counts as stalled.
 *
 * Steady state is ~43 observations/minute across the fleet, so a gap this long is not a quiet
 * period. Deliberately generous relative to the one-minute poll: one slow message must not page.
 * `scripts/ops/queue/cli.ts` holds the same number for its exit code — deliberately duplicated,
 * because the CLI runs against a *deployed* origin and cannot import this module.
 */
export const INGEST_STALL_THRESHOLD_MIN = 5;

/**
 * What the ingest path is called.
 *
 * It was the QStash Queue's name until the 2026-09-10 cutover, and it stays the name afterwards on
 * purpose: it is what `liveone queue` prints, what the CLI reference documents, and the muscle
 * memory built during the incident. It now names the PATH — two flow-control lanes — not a Queue.
 */
const INGEST_PATH_NAME = "observations";

/** One flow-control lane, as QStash reports it (or as it renders when QStash has no state). */
export interface LaneState {
  lane: ObservationLane;
  /** The flow-control key, e.g. `obs.live`. Environment-prefixed — see `lib/qstash.ts`. */
  key: string;
  /** Messages accepted but not yet dispatched (`waitListSize`). */
  waiting: number;
  /**
   * Deliveries in flight right now (`parallelismCount`).
   *
   * This is the number that did not exist during the incident. `parallelismMax: 5,
   * parallelismCount: 5, waitListSize: 1000` states the diagnosis in one line; `lag: 1053` alone
   * was misread as a throughput deficit twice.
   */
  inFlight: number;
  /** The concurrency cap in force (`parallelismMax`), or our publish-time default when idle. */
  parallelism: number;
  /** True when an operator pinned the cap, so our own publishes can no longer revert it. */
  pinned: boolean;
  paused: boolean;
  /** True when QStash holds no state for this key at all. A state, not a failure. */
  idle: boolean;
  /**
   * Set when this lane could NOT be read — an unexpected QStash response, not a missing key.
   *
   * 🛑 The lane still renders (as zeros), because a throw here would 500 the entire status view at
   * the exact moment an operator needs it. But it must never render as a healthy idle lane either:
   * "I could not see this" and "there is nothing here" are the distinction the whole module exists
   * to preserve. Readers surface it — `monitor-observations` warns `ingest_lane_unreadable`.
   */
  error?: string;
}

/** A lane plus the verdict that needs fleet-wide ingest recency to compute. */
interface LaneView extends LaneState {
  /**
   * Saturated, backed up, and nothing is landing — the head-of-line signature.
   *
   * 🛑 This is the check the incident needed. An empty DLQ is not "nothing is wrong": with one
   * message retrying and everything behind it unattempted, `dlqCount` stayed 0 for 2h20m while this
   * predicate would have been true throughout.
   */
  stuck: boolean;
}

export interface IngestState {
  /** Historical name of the ingest path. Since the lane split this names the PATH, not a Queue. */
  name: string;
  /**
   * Account-wide concurrency, across every flow-control key. Answers the question that went
   * unanswered during the incident — *"I raised parallelism and nothing changed, why?"* Never
   * alert on it: a healthy busy fleet can touch it.
   */
  globalParallelism: { max: number; inFlight: number } | null;
  /** Σ waiting across lanes. */
  waiting: number;
  /** Σ in flight across lanes. */
  inFlight: number;
  pausedLanes: ObservationLane[];
  lanes: LaneView[];
  /** ISO8601 of the last durable write by the receiver, or null when nothing ever landed. */
  lastIngestedAt: string | null;
  /** Minutes since that write. `null` when `lastIngestedAt` is null. */
  stalledMinutes: number | null;
  /** `stalledMinutes > INGEST_STALL_THRESHOLD_MIN`. */
  stalled: boolean;
  /** Every lane paused. */
  paused: boolean;
}

/** True for the "this key/queue does not exist" response, which is a state and not a failure. */
function isNotFound(error: unknown): boolean {
  const err = error as { message?: string; status?: number } | null;
  return err?.status === 404 || !!err?.message?.includes("not found");
}

/** How a lane renders when QStash holds no state for its key. */
function idleLane(lane: ObservationLane): LaneState {
  return {
    lane,
    key: observationsFlowKey(lane),
    waiting: 0,
    inFlight: 0,
    // The cap our next publish would carry — the honest answer to "what is it set to", since an
    // unpinned key's cap comes from the message, not from QStash.
    parallelism: laneParallelism(lane),
    pinned: false,
    paused: false,
    idle: true,
  };
}

/** One lane's live state. A missing key renders as `idle`; any other failure as `error`. */
async function readLane(lane: ObservationLane): Promise<LaneState> {
  if (!qstash) return idleLane(lane);
  const key = observationsFlowKey(lane);
  try {
    const info = await qstash.flowControl.get(key);
    return {
      lane,
      key,
      waiting: info.waitListSize ?? 0,
      inFlight: info.parallelismCount ?? 0,
      parallelism: info.parallelismMax || laneParallelism(lane),
      pinned: info.isPinnedParallelism ?? false,
      paused: info.isPaused ?? false,
      idle: false,
    };
  } catch (error) {
    if (isNotFound(error)) return idleLane(lane);
    return { ...idleLane(lane), idle: false, error: String(error) };
  }
}

/** Both lanes, always both — see the 🛑 in the header. */
export async function readLanes(): Promise<LaneState[]> {
  return Promise.all(OBSERVATION_LANES.map(readLane));
}

/** Account-wide concurrency, or null when QStash is unconfigured or does not report it. */
export async function readGlobalParallelism(): Promise<{
  max: number;
  inFlight: number;
} | null> {
  if (!qstash) return null;
  const info = await qstash.flowControl.getGlobalParallelism();
  return {
    max: info.parallelismMax ?? 0,
    inFlight: info.parallelismCount ?? 0,
  };
}

/** The full control-plane read: every lane, plus ingest recency from Postgres. */
export async function readIngestState(): Promise<IngestState> {
  const [lanes, global, lastMs] = await Promise.all([
    readLanes(),
    // Account-wide parallelism is a hint, never a signal — a failure here must not take down the
    // one view an operator has during an outage.
    readGlobalParallelism().catch(() => null),
    planetscaleDb ? ReadingsDao.latestIngestCreatedAtMs() : null,
  ]);

  const stalledMinutes =
    lastMs != null
      ? Math.round(((Date.now() - lastMs) / 60000) * 10) / 10
      : null;
  const stalled =
    stalledMinutes != null && stalledMinutes > INGEST_STALL_THRESHOLD_MIN;

  const laneViews: LaneView[] = lanes.map((l) => ({
    ...l,
    // An unreadable lane makes no claim either way — zeros are the absence of a reading, not a
    // measurement, and calling that "not stuck" would be the healthy-looking blindness again.
    stuck: !l.error && l.inFlight >= l.parallelism && l.waiting > 0 && stalled,
  }));

  return {
    name: INGEST_PATH_NAME,
    globalParallelism: global,
    waiting: laneViews.reduce((n, l) => n + l.waiting, 0),
    inFlight: laneViews.reduce((n, l) => n + l.inFlight, 0),
    pausedLanes: laneViews.filter((l) => l.paused).map((l) => l.lane),
    lanes: laneViews,
    lastIngestedAt: lastMs != null ? new Date(lastMs).toISOString() : null,
    stalledMinutes,
    stalled,
    paused: laneViews.every((l) => l.paused),
  };
}

// ── writes ────────────────────────────────────────────────────────────────────────────────────

/** The client, or a thrown error — every write below needs a real one. */
function requireQstash(): NonNullable<typeof qstash> {
  if (!qstash) throw new Error("QStash is not configured");
  return qstash;
}

/**
 * 🛑 Set concurrency by PINNING it, never by publish option.
 *
 * Every message we publish carries `flowControl.parallelism`, so an unpinned operator change is
 * reverted by the very next poll — within ~60 s, mid-incident, silently. `pin` makes QStash ignore
 * the value on incoming messages until it is unpinned.
 */
export async function pinLaneParallelism(
  lane: ObservationLane,
  parallelism: number,
): Promise<void> {
  await requireQstash().flowControl.pin(observationsFlowKey(lane), {
    parallelism,
  });
}

/** Hand concurrency back to the publish-time value (`laneParallelism`). */
export async function unpinLaneParallelism(
  lane: ObservationLane,
): Promise<void> {
  await requireQstash().flowControl.unpin(observationsFlowKey(lane), {
    parallelism: true,
  });
}

/** Stop dispatching a lane. Publishing is unaffected — messages accumulate in the wait list. */
export async function setLanePaused(
  lane: ObservationLane,
  paused: boolean,
): Promise<void> {
  const fc = requireQstash().flowControl;
  const key = observationsFlowKey(lane);
  await (paused ? fc.pause(key) : fc.resume(key));
}
