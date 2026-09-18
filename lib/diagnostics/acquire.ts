/**
 * Server-side acquisition: open the SP LINK tunnel, read the inverter's event logs, store the
 * capture and the events it yielded.
 *
 * This is the one place in the app that connects to `select.live:7528`. It composes
 * `lib/selectlive` — which stays free of database and Clerk dependencies — with `./store`.
 *
 * 🛑 Read-only, and narrowly so. The only write the protocol client can perform is the inverter
 * AUTHENTICATION response; no setting is changed, no fault is reset and no generator command is
 * issued. Nothing here should ever grow one: a control path needs its own traced sequence, its own
 * verification, and its own decision.
 *
 * Bounded on purpose. The minutely cron has a 60-second budget and the inverter permits one SP LINK
 * session, so an attempt gets `ATTEMPT_BUDGET_MS` and then stops wherever it is. A partial capture
 * is stored and marked partial: during an outage, a partial capture of the fault that is happening
 * right now is the best evidence there will ever be.
 */
import { createHash } from "node:crypto";
import {
  connect,
  Portal,
  type PortalCredentials,
} from "@/lib/selectlive/transport";
import {
  Inverter,
  deviceInfo,
  type DeviceInfo,
} from "@/lib/selectlive/protocol";
import { timestampUtc } from "@/lib/selectlive/history";
import {
  acquireEventLog,
  decodeEventRecord,
  eventRecordId,
  EVENT_DECODER_VERSION,
  EVENT_LOG_NAMES,
  readDeviceClock,
  readScales,
  supportedEventFormat,
  type DecodedEvent,
  type EventAcquisition,
  type EventLog,
} from "@/lib/selectlive/events";
import { SelectLiveError } from "@/lib/selectlive/errors";
import {
  ingestInverterEvents,
  insertCapture,
  resumeAnchors,
  updateCapture,
  type TriggerReason,
} from "./store";

/** One attempt's wall-clock budget. Comfortably inside the 60-second cron, with room to close the
 * connection and write the capture afterwards. */
export const ATTEMPT_BUDGET_MS = 40_000;
/** The factory default, and what SP LINK itself offers. Overridden per device in Clerk metadata. */
const DEFAULT_INVERTER_PASSWORD = "Selectronic SP PRO";

export interface AcquisitionRequest {
  deviceRid: number;
  /** Select.live portal system id — the inverter SERIAL is what the tunnel selects. */
  serial: string;
  portal: PortalCredentials;
  inverterPassword?: string;
  /** The device clock's zone, for computing UTC timestamps and the clock offset. */
  timezone?: string;
  jobId?: string;
  reasons: TriggerReason[];
  budgetMs?: number;
  signal?: AbortSignal;
}

export interface AcquisitionOutcome {
  captureId: string;
  complete: boolean;
  recordCount: number;
  newRecordCount: number;
  /** Resumed logs whose previous anchor was PROVED absent — the whole retained ring was walked and
   * it was not there, so the records in between are gone from the inverter for good. */
  lostOverlap: EventLog[];
  /** Resumed logs where the walk stopped before reaching the anchor. Says nothing about whether
   * those records still exist; a retry may still confirm the overlap. NOT data loss. */
  unverifiedOverlap: EventLog[];
  /** Logs that were requested but never read — the budget ran out first. */
  skippedLogs: EventLog[];
  clockOffsetSeconds: number | null;
  error?: string;
}

export async function acquireDiagnostics(
  request: AcquisitionRequest,
): Promise<AcquisitionOutcome> {
  const startedAt = new Date();
  const deadlineMs =
    startedAt.getTime() + (request.budgetMs ?? ATTEMPT_BUDGET_MS);
  const requestedLogs = EVENT_LOG_NAMES;
  const captureId = await insertCapture({
    deviceRid: request.deviceRid,
    jobId: request.jobId ?? null,
    startedAt,
    complete: false,
    decoderVersion: EVENT_DECODER_VERSION,
  });

  let portal: Portal | undefined;
  const acquisitions: EventAcquisition[] = [];
  let identity: DeviceInfo | null = null;
  let scales = null as Awaited<ReturnType<typeof readScales>> | null;
  let clock = null as Awaited<ReturnType<typeof readDeviceClock>> | null;
  let error: string | undefined;
  try {
    portal = new Portal(await connect(request.signal));
    await portal.login(request.portal);
    await portal.select(request.serial);
    const inverter = new Inverter(portal.channel);
    await inverter.login(request.inverterPassword ?? DEFAULT_INVERTER_PASSWORD);
    identity = await deviceInfo(inverter);
    // Connecting to the wrong inverter would attribute one site's faults to another. The portal
    // selects by serial, so a mismatch is a protocol failure, not a warning.
    if (BigInt(identity.serial) !== BigInt(request.serial))
      throw new SelectLiveError(
        "protocol",
        "Connected inverter identity differs from the requested serial.",
      );
    clock = await readDeviceClock(inverter, request.timezone);
    scales = await readScales(inverter);
    const anchors = await resumeAnchors(request.deviceRid);
    for (const log of requestedLogs) {
      if (Date.now() > deadlineMs || request.signal?.aborted) break;
      acquisitions.push(
        await acquireEventLog(inverter, log, {
          since: anchors[log],
          deadlineMs,
          signal: request.signal,
        }),
      );
    }
  } catch (caught) {
    error =
      caught instanceof SelectLiveError
        ? `${caught.kind}: ${caught.message}`
        : "Diagnostic acquisition failed.";
  } finally {
    portal?.close();
  }

  const records = acquisitions.flatMap((a) => a.records);
  const supported =
    identity !== null &&
    acquisitions.length > 0 &&
    acquisitions.every((a) =>
      supportedEventFormat(identity!.versions.events, a.before.entryWords),
    );
  const raw = records.map((r) => ({
    log: r.log,
    address: r.address,
    hex: r.hex,
  }));
  const sha256 = createHash("sha256")
    .update(raw.map((r) => JSON.stringify(r)).join("\n"))
    .digest("hex");

  const lostOverlap = acquisitions
    .filter((a) => a.overlapVerdict === "lost")
    .map((a) => a.log);
  const unverifiedOverlap = acquisitions
    .filter((a) => a.overlapVerdict === "unverified")
    .map((a) => a.log);
  const read = new Set(acquisitions.map((a) => a.log));
  const skippedLogs = requestedLogs.filter((log) => !read.has(log));
  // 🛑 EVERY requested log, not just the ones that ran. The budget can expire between the two, and
  // `every()` over a one-element array is vacuously true — which would have marked a job done
  // having never opened the operational log at all.
  //
  // This is the WALK half only. Whether the capture is complete also depends on the records having
  // been decoded and stored, which has not happened yet — see `complete` below.
  const walkComplete =
    !error &&
    skippedLogs.length === 0 &&
    acquisitions.length === requestedLogs.length &&
    acquisitions.every((a) => a.complete);

  let decoded: DecodedEvent[] = [];
  let decodeOk = supported && scales !== null;
  if (supported && scales) {
    try {
      decoded = records.map((record) => decodeEventRecord(record, scales!));
    } catch (caught) {
      // Raw records are already on their way to storage; a decoder failure must not lose them.
      error ??=
        caught instanceof SelectLiveError
          ? caught.message
          : "Event decoding failed; raw records are preserved.";
      decoded = [];
      decodeOk = false;
    }
  }

  // 🛑 The BYTES go down first, in one write, before a single decoded row is inserted.
  //
  // The acquisition is the irreplaceable part: the inverter's ring overwrites itself, so these
  // records exist nowhere else once it wraps. Ingesting first meant N awaited inserts standing
  // between a successful read and its evidence being durable — a timeout in there left an empty
  // capture stub, some decoded rows with no bytes behind them, and (worse) an anchor derived from
  // a capture that was never stored.
  await updateCapture(captureId, {
    finishedAt: new Date(),
    // Not complete YET, and deliberately written that way: if this function dies between the two
    // writes, the capture reads incomplete, the job is retried, and the next walk starts from
    // whatever the LAST anchor was rather than from one this capture never earned.
    complete: false,
    identity,
    metadata: Object.fromEntries(
      acquisitions.map(({ records: _records, ...rest }) => [rest.log, rest]),
    ),
    scales,
    clock,
    recordCount: records.length,
    // 🛑 WITHOUT anchors, deliberately. The bytes are durable from here, but nothing has been
    // decoded into `device_events` yet — and an anchor published now would let the next
    // acquisition skip past records whose decoded rows never landed. The anchors go in the second
    // write below, once ingestion has actually succeeded.
    coverage: coverageOf(false),
    sha256,
    raw,
    error,
  });

  let newRecordCount = 0;
  if (decoded.length) {
    try {
      newRecordCount = await ingestInverterEvents(
        request.deviceRid,
        captureId,
        decoded,
        request.timezone,
        (event) => {
          if (!request.timezone) return null;
          try {
            return new Date(timestampUtc(event.device_time, request.timezone));
          } catch {
            // Ambiguous in a DST fold. The device's own text is stored regardless; guessing an
            // hour here would put a fault an hour from where it happened.
            return null;
          }
        },
        new Date(),
      );
    } catch (caught) {
      // The bytes are already durable. Record the failure on the capture and publish NO anchor, so
      // the next acquisition re-reads this range rather than stepping over events that never
      // landed; the job is reported incomplete and retried.
      const message =
        caught instanceof Error
          ? `Event ingestion failed: ${caught.message}`
          : "Event ingestion failed.";
      // Already `complete: false` from the first write; restate it with the reason. No anchor was
      // ever published, so the next walk re-reads this range.
      await updateCapture(captureId, { complete: false, error: message });
      return {
        captureId,
        complete: false,
        recordCount: records.length,
        newRecordCount: 0,
        lostOverlap,
        unverifiedOverlap,
        skippedLogs,
        clockOffsetSeconds: clock?.offsetSeconds ?? null,
        error: message,
      };
    }
  }

  /**
   * 🛑 An anchor requires the records to have been DECODED AND STORED, not merely read.
   *
   * `supported` is false for a firmware whose event format we cannot decode — the walk completes,
   * the bytes land, and nothing is ingested. Publishing an anchor there would make every later
   * acquisition skip past records that are not in `device_events` and never will be, including
   * after decoder support is added. Same for a decode exception.
   *
   * 🛑 But the gate is PER LOG, not per capture, and that distinction is what lets a retry make
   * progress. Ingestion is CHUNKED rather than transactional, but it is awaited to completion and a
   * failed chunk returns through the path above without publishing anything — so reaching here
   * means every record read has landed, and a log whose own walk completed has earned its anchor
   * even if the capture as a whole did not. Withholding it because a SECOND log ran out of budget
   * is how an acquisition gets stuck: a 25-second alert walk followed by a truncated operational
   * walk would re-read the alert log in full on every attempt, and truncate operational again,
   * until the ladder was exhausted.
   */
  const complete = walkComplete && decodeOk;
  await updateCapture(captureId, {
    complete,
    newRecordCount,
    coverage: coverageOf(decodeOk),
    error,
  });

  return {
    captureId,
    complete,
    recordCount: records.length,
    newRecordCount,
    lostOverlap,
    unverifiedOverlap,
    skippedLogs,
    clockOffsetSeconds: clock?.offsetSeconds ?? null,
    error,
  };

  /**
   * The per-log summary, including the RESUME ANCHOR each log may be continued from.
   *
   * 🛑 A log that did not complete contributes NO anchor. An anchor names a point past which
   * everything is known to be held, and a truncated walk has not established that: taking the
   * newest record of a partial walk would make the next resume stop at it immediately and report
   * success, permanently skipping everything older that was never read. `resumeAnchors` therefore
   * reads anchors only from complete logs, and this is where that guarantee is written down.
   */
  function coverageOf(withAnchors: boolean) {
    return {
      supportedFormat: supported,
      lostOverlap,
      unverifiedOverlap,
      skippedLogs,
      reasons: request.reasons,
      logs: Object.fromEntries(
        acquisitions.map((a) => [
          a.log,
          {
            acquired: a.records.length,
            advertised: a.before.recordCount,
            complete: a.complete,
            stoppedBecause: a.stoppedBecause,
            earliestDeviceTime: a.earliestDeviceTime,
            latestDeviceTime: a.latestDeviceTime,
            overlapObserved: a.overlapObserved,
            overlapVerdict: a.overlapVerdict,
            anchor:
              withAnchors && a.complete && a.records.length
                ? {
                    deviceSeconds: a.records[0].deviceSeconds,
                    id: eventRecordId(
                      a.log,
                      a.records[0].deviceSeconds,
                      a.records[0].hex,
                    ),
                  }
                : null,
          },
        ]),
      ),
    };
  }
}
