/**
 * Preserve the inverter's event logs to a local acquisition directory.
 *
 * Same shape and same discipline as `downloadHistory` in ./history.ts — a fresh directory per
 * invocation, raw records written and hashed BEFORE anything is decoded, a manifest that states
 * what is incomplete rather than quietly omitting it — but for the alert/operational logs, and
 * with one addition: `--resume`. The event logs are small and slow-moving, so re-reading all of
 * them every time is wasteful and, more importantly, gives no evidence about the interval between
 * two captures. Resuming from the previous manifest's anchor makes the overlap explicit: either the
 * anchor record is seen again (nothing was missed) or it is not, and the gap is reported.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type MemoryReader, type DeviceInfo } from "./protocol";
import { SelectLiveError, protocolError } from "./errors";
import { timestampUtc } from "./history";
import {
  acquireEventLog,
  decodeEventRecord,
  eventRecordId,
  EVENT_CSV_COLUMNS,
  EVENT_DECODER_VERSION,
  EVENT_LOG_NAMES,
  readDeviceClock,
  readScales,
  supportedEventFormat,
  type DeviceClock,
  type EventAcquisition,
  type EventAnchor,
  type EventLog,
  type EventScales,
} from "./events";
import { labelProvenance } from "./event-labels";

export interface EventDownloadOptions {
  out: string;
  logs?: EventLog[];
  timezone?: string;
  /** Inclusive local start date (YYYY-MM-DD). Filters the exported CSV only. */
  start?: string;
  /** Exclusive local end date (YYYY-MM-DD). Filters the exported CSV only. */
  end?: string;
  /** A previous acquisition's manifest.json, for an incremental read. */
  resume?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  progress?: (log: EventLog, records: number, advertised: number) => void;
}

export interface EventManifest {
  version: 1;
  directory: string;
  device: DeviceInfo;
  startedAt: string;
  finishedAt?: string;
  timezone?: string;
  filter: { start?: string; end?: string };
  decoderVersion: number;
  labelProvenance: typeof labelProvenance;
  scales: EventScales | null;
  clock: DeviceClock | null;
  supportedFormat: boolean;
  resumedFrom?: string;
  /** Per log, everything needed to judge the capture and to resume from it. */
  logs: Record<string, EventManifestLog>;
  complete: boolean;
  decoding:
    | "pending"
    | "decoded"
    | "timezone_required"
    | "unsupported_format"
    | "not_attempted_incomplete"
    | "failed";
  csvRows?: number;
  rawSha256?: string;
  error?: string;
}

/**
 * One log's entry in the manifest.
 *
 * The acquisition fields are OPTIONAL because every requested log gets an entry BEFORE the walk
 * starts, carrying whatever anchor it inherited. That seeding is not tidiness — it is the fix for a
 * real hole: a resume that failed on the clock read, or partway through the first log, used to
 * write a manifest with no entry at all for the logs it never reached, and resuming from THAT
 * manifest silently did a full read for them. A full read cannot report a lost overlap, so a ring
 * that wrapped in between would have produced a clean-looking download with a hole in it.
 */
interface EventManifestLog
  extends Partial<Omit<EventAcquisition, "records" | "log">> {
  log: EventLog;
  /** True once the walk has been STARTED — not once it has returned. A descriptor read that throws
   * still counts as attempted; what survives regardless is the inherited `anchor`. */
  attempted: boolean;
  acquiredRecords: number;
  /** Feed this back as the anchor next time. */
  anchor: EventAnchor | null;
  requestedSince: EventAnchor | null;
}

const anchorSchema = z.object({ deviceSeconds: z.number(), id: z.string() });
const resumeSchema = z.object({
  version: z.literal(1),
  logs: z.record(
    z.string(),
    z.object({ anchor: anchorSchema.nullable().optional() }),
  ),
});

/** Read the anchors a previous acquisition left behind. A manifest we cannot parse is a usage
 * error, not an excuse to silently fall back to a full read. */
export function readResumeAnchors(
  file: string,
): Partial<Record<EventLog, EventAnchor>> {
  let parsed;
  try {
    parsed = resumeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    throw new SelectLiveError(
      "usage",
      "--resume must name a manifest.json written by a previous selectlive events download.",
    );
  }
  const anchors: Partial<Record<EventLog, EventAnchor>> = {};
  for (const log of EVENT_LOG_NAMES) {
    const anchor = parsed.logs[log]?.anchor;
    if (anchor) anchors[log] = anchor;
  }
  return anchors;
}

export function validateEventDownloadOptions(
  options: EventDownloadOptions,
): void {
  if (options.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format();
    } catch {
      throw new SelectLiveError(
        "usage",
        "--timezone must be a valid IANA timezone, for example Australia/Melbourne.",
      );
    }
  }
  if ((options.start || options.end) && !options.timezone)
    throw new SelectLiveError("usage", "Date filtering requires --timezone.");
  for (const date of [options.start, options.end])
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      throw new SelectLiveError(
        "usage",
        "Dates must be valid ISO dates (YYYY-MM-DD).",
      );
  if (options.start && options.end && options.start >= options.end)
    throw new SelectLiveError(
      "usage",
      "--start must be before the exclusive --end date.",
    );
}

export async function downloadEvents(
  reader: MemoryReader,
  device: DeviceInfo,
  options: EventDownloadOptions,
): Promise<EventManifest> {
  validateEventDownloadOptions(options);
  const logs = options.logs?.length ? options.logs : EVENT_LOG_NAMES;
  const anchors = options.resume ? readResumeAnchors(options.resume) : {};
  fs.mkdirSync(options.out, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(path.resolve(options.out), `selectlive-events-${device.serial}-`),
  );
  const manifest: EventManifest = {
    version: 1,
    directory,
    device,
    startedAt: new Date().toISOString(),
    timezone: options.timezone,
    filter: { start: options.start, end: options.end },
    decoderVersion: EVENT_DECODER_VERSION,
    labelProvenance,
    scales: null,
    clock: null,
    supportedFormat: false,
    resumedFrom: options.resume,
    // Seeded before anything is read, so a failure anywhere below still carries every requested
    // log's inherited anchor forward.
    logs: Object.fromEntries(
      logs.map((log) => [
        log,
        {
          log,
          attempted: false,
          acquiredRecords: 0,
          anchor: anchors[log] ?? null,
          requestedSince: anchors[log] ?? null,
        } satisfies EventManifestLog,
      ]),
    ),
    complete: false,
    decoding: "pending",
  };
  const manifestPath = path.join(directory, "manifest.json");
  const writeManifest = () => {
    fs.writeFileSync(
      `${manifestPath}.tmp`,
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  };
  writeManifest();

  const rawPath = path.join(directory, "records.jsonl");
  const fd = fs.openSync(rawPath, "wx", 0o600);
  const hash = createHash("sha256");
  const acquisitions: EventAcquisition[] = [];
  try {
    manifest.clock = await readDeviceClock(reader, options.timezone);
    manifest.scales = await readScales(reader);
    writeManifest();
    for (const log of logs) {
      // Marked BEFORE the call: `acquireEventLog` can throw on the descriptor read, and a manifest
      // that then said "not read" would be describing a log we did try. The inherited anchor stays
      // where it is either way, which is the part that matters for the next resume.
      manifest.logs[log].attempted = true;
      const acquisition = await acquireEventLog(reader, log, {
        since: anchors[log],
        deadlineMs: options.deadlineMs,
        signal: options.signal,
        onProgress: (done, total) => options.progress?.(log, done, total),
      });
      acquisitions.push(acquisition);
      for (const record of acquisition.records) {
        const line =
          JSON.stringify({
            log: record.log,
            address: record.address,
            hex: record.hex,
          }) + "\n";
        fs.writeSync(fd, line);
        hash.update(line);
      }
      const newest = acquisition.records[0] ?? null;
      const { records, ...rest } = acquisition;
      manifest.logs[log] = {
        ...rest,
        attempted: true,
        acquiredRecords: records.length,
        // 🛑 Only a COMPLETED walk may advance the anchor. An anchor asserts that everything newer
        // than it is already held, and a walk that stopped on its deadline has not established
        // that: taking its newest record would make the next --resume meet that anchor on its
        // first batch and report success, permanently skipping everything older it never read.
        // A partial walk keeps the PREVIOUS anchor, so the next run re-attempts the same gap.
        anchor:
          acquisition.complete && newest
            ? {
                deviceSeconds: newest.deviceSeconds,
                id: eventRecordId(log, newest.deviceSeconds, newest.hex),
              }
            : (anchors[log] ?? null),
        requestedSince: anchors[log] ?? null,
      };
      writeManifest();
      if (options.signal?.aborted)
        throw new SelectLiveError("interrupted", "Operation interrupted.");
    }
    manifest.complete = acquisitions.every((a) => a.complete);
  } catch (error) {
    manifest.error =
      error instanceof SelectLiveError
        ? error.message
        : "Event acquisition failed.";
    manifest.decoding = "not_attempted_incomplete";
  } finally {
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    manifest.finishedAt = new Date().toISOString();
    manifest.rawSha256 = hash.digest("hex");
    manifest.supportedFormat = acquisitions.every((a) =>
      supportedEventFormat(device.versions.events, a.before.entryWords),
    );
    writeManifest();
  }

  if (manifest.decoding === "pending") {
    if (!manifest.supportedFormat) manifest.decoding = "unsupported_format";
    else if (!options.timezone) manifest.decoding = "timezone_required";
    else {
      try {
        const start = options.start
          ? timestampUtc(`${options.start}T00:00:00`, options.timezone)
          : undefined;
        const end = options.end
          ? timestampUtc(`${options.end}T00:00:00`, options.timezone)
          : undefined;
        const scales = manifest.scales;
        if (!scales) protocolError("Scaling factors were not read.");
        const decoded = acquisitions
          .flatMap((a) => a.records)
          .map((record) => ({
            decoded: decodeEventRecord(record, scales),
            utc: timestampUtc(record.deviceTime, options.timezone!),
          }))
          .filter(({ utc }) => (!start || utc >= start) && (!end || utc < end))
          .sort(
            (a, b) =>
              a.decoded.device_time.localeCompare(b.decoded.device_time) ||
              a.decoded.log.localeCompare(b.decoded.log),
          );
        const cell = (v: unknown) =>
          v == null ? "" : `"${String(v).replace(/"/g, '""')}"`;
        const csv =
          [
            [...EVENT_CSV_COLUMNS, "timestamp_utc"].join(","),
            ...decoded.map(({ decoded: row, utc }) =>
              [
                ...EVENT_CSV_COLUMNS.map((c) =>
                  cell(row[c as keyof typeof row]),
                ),
                cell(utc),
              ].join(","),
            ),
          ].join("\n") + "\n";
        fs.writeFileSync(path.join(directory, "events.csv"), csv, {
          flag: "wx",
          mode: 0o600,
        });
        manifest.decoding = "decoded";
        manifest.csvRows = decoded.length;
      } catch (error) {
        manifest.decoding = "failed";
        manifest.error =
          error instanceof SelectLiveError
            ? error.message
            : "CSV conversion failed; raw records are preserved.";
      }
    }
    writeManifest();
  }
  return manifest;
}
