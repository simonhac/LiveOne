/**
 * Poll Collector
 *
 * Buffers a poll's raw observation inputs and emits a single combined QStash
 * message at session close — the completed session plus all of its readings,
 * chunked by `./chunk` so no one message exceeds either the byte or the
 * observation-count bound.
 *
 * This is the sole publish path for polls: one co-enqueued session+readings
 * message per chunk (replacing the old per-insert + separate-session flow).
 */

import { qstash, getObservationsReceiverUrl } from "@/lib/qstash";
import { ObservationLane, QueueMessage, Session } from "./types";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { formatTime_fromJSDate } from "@/lib/date-utils";
import { buildObservations, RawObservationInput } from "./publisher";
import { persistOutbox } from "./outbox";
import { publishObservationMessage } from "./publish";
import { buildChunkedMessages } from "./chunk";
import { qualityRank } from "@/lib/data-quality";

/**
 * Accumulates raw observation inputs over the course of a poll, preserving
 * insertion order, so they can be flushed as a single combined message at
 * session close.
 *
 * 🛑 **One observation per addressable row.** A poll may call several vendor endpoints, and two of
 * them can legitimately report the same reading — see `add()`. The collector is the only place that
 * can notice, because the fetches are independent functions that share nothing but this buffer.
 */
export interface PollCollector {
  /**
   * Append observation inputs, MERGING any that address a row already held.
   *
   * The address is `(pointUid, interval, measurementTime)` — precisely what the serving store keys
   * on — and the survivor is whichever one the store itself would have ended up with:
   *
   *   • `raw` keeps the FIRST, because `insertRaw` is `ON CONFLICT DO NOTHING`.
   *   • `5m` / `1d` keep the most-final `data_quality` (`qualityRank`), last-wins on a tie, because
   *     those are upserts.
   *
   * So merging here changes no stored value. What it removes is the redundant row — and with it a
   * whole class of failure, since a duplicate PK inside one `ON CONFLICT DO UPDATE` statement makes
   * Postgres reject the ENTIRE statement (SQLSTATE 21000). `lib/readings/dao.ts` collapses again at
   * the writer, which is what protects replays of already-built payloads; this is what stops us
   * building them.
   *
   * The live case: Amber's `usage` and `pricing` fetches both report a channel's `perKwh` — usage
   * graded `b`illable, pricing graded `a`ctual — and a backfill runs both into one collector. Each
   * is right to report it (only `pricing` has current/forecast intervals, only `usage` has the
   * billed grading), so this is a genuine overlap to resolve, not a bug in either.
   */
  add(inputs: RawObservationInput[]): void;
  /** All accumulated inputs, in first-appearance order, one per address. */
  readonly observations: RawObservationInput[];
  /**
   * How many inputs were merged into an existing row rather than appended.
   *
   * Surfaced (not silently swallowed) because a rising count on a vendor that should have no
   * overlapping endpoints is the visible edge of a producer bug.
   */
  readonly mergedCount: number;
  /**
   * Which flow-control lane this poll's messages ride.
   *
   * Carried on the COLLECTOR rather than passed separately at publish time so there is one source
   * of truth: the site that decides "this is a backfill" is the site that creates the collector.
   */
  readonly lane: ObservationLane;
}

/** The address an observation writes to — the serving store's key, not the vendor's. */
function observationAddress(input: RawObservationInput): string {
  return `${input.point.pointUid}|${input.interval}|${input.measurementTimeMs}`;
}

/**
 * Create a new poll collector that buffers observation inputs in memory.
 */
export function createPollCollector(opts?: {
  lane?: ObservationLane;
}): PollCollector {
  const buffer: RawObservationInput[] = [];
  const indexByAddress = new Map<string, number>();
  const lane: ObservationLane = opts?.lane ?? "live";
  let mergedCount = 0;
  return {
    add(inputs: RawObservationInput[]): void {
      for (const input of inputs) {
        const address = observationAddress(input);
        const at = indexByAddress.get(address);
        if (at === undefined) {
          indexByAddress.set(address, buffer.length);
          buffer.push(input);
          continue;
        }
        mergedCount++;
        // Mirror the store, per interval — see the `add()` doc.
        if (input.interval === "raw") continue;
        if (
          qualityRank(input.agg?.dataQuality) >=
          qualityRank(buffer[at].agg?.dataQuality)
        )
          buffer[at] = input;
      }
    },
    get observations(): RawObservationInput[] {
      return buffer;
    },
    get mergedCount(): number {
      return mergedCount;
    },
    lane,
  };
}

/**
 * Build the combined QStash message(s) for a completed poll.
 *
 * PURE (no I/O). Produces one or more QueueMessages, each carrying the same
 * `session` and a contiguous slice of the poll's observations. Chunking (and
 * both of its bounds) lives in `./chunk` — see that module for why the count
 * cap exists alongside the byte cap.
 */
export function buildPollMessages(args: {
  device: DeviceConfigView;
  session: Session;
  inputs: RawObservationInput[];
  lane?: ObservationLane;
  maxBytes?: number;
  maxCount?: number;
}): QueueMessage[] {
  const { device, session, inputs } = args;

  const env: QueueMessage["env"] =
    process.env.NODE_ENV === "production" ? "prod" : "dev";
  const batchTime = formatTime_fromJSDate(new Date(), device.timezoneOffsetMin);

  return buildChunkedMessages({
    base: () => ({
      env,
      lane: args.lane ?? "live",
      systemId: device.id,
      systemName: device.displayName,
      batchTime,
      session,
    }),
    observations: buildObservations(device, inputs),
    maxBytes: args.maxBytes,
    maxCount: args.maxCount,
  });
}

/**
 * Publish a completed poll (session + all buffered observations) to the QStash
 * queue as one combined message per chunk.
 *
 * Side-effectful: builds messages via {@link buildPollMessages} and enqueues
 * each. If QStash is not configured (no client) or there is no receiver URL,
 * this silently no-ops. Errors are logged but never thrown — queue failures
 * must not break the main poll flow.
 */
export async function publishPoll(
  device: DeviceConfigView,
  session: Session,
  collector: PollCollector,
): Promise<void> {
  // Skip if no QStash client configured.
  if (!qstash) {
    return;
  }

  // Skip if no receiver URL (e.g., development without override).
  const receiverUrl = getObservationsReceiverUrl();
  if (!receiverUrl) {
    return;
  }

  try {
    const messages = buildPollMessages({
      device,
      session,
      inputs: collector.observations,
      lane: collector.lane,
    });

    // Durably capture the messages in PG first (a tee, in parallel with the live
    // direct enqueue below). Best-effort — never throws — so the direct enqueue and
    // the poll proceed unchanged when PG is momentarily down. This is the durability
    // anchor: the relay re-drains anything the direct enqueue drops.
    await persistOutbox(messages);

    for (const message of messages) {
      await publishObservationMessage(message);
    }

    const totalObservations = messages.reduce(
      (sum, message) => sum + (message.observations?.length ?? 0),
      0,
    );
    console.log(
      `[PollCollector] Published poll for system ${device.id} on lane ${collector.lane}: ` +
        `${messages.length} message(s), ${totalObservations} observations, ` +
        // Two endpoints reporting one reading is expected for Amber and nothing else — so this
        // number appearing on another vendor is worth chasing. See PollCollector.add.
        (collector.mergedCount ? `${collector.mergedCount} merged, ` : "") +
        `session ${session.sessionId}`,
    );
  } catch (error) {
    // Log error but don't throw - the main poll flow must not be blocked by
    // queue failures.
    console.error(
      `[PollCollector] Failed to publish poll for system ${device.id}:`,
      error,
    );
  }
}
