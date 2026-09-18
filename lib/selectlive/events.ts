/**
 * The SP PRO's two internal EVENT logs — `alert` and `operational`.
 *
 * These are a different dataset from the detailed log in ./history.ts. The detailed log is
 * PERIODIC MEASUREMENT HISTORY (15-minute averages on this installation). An event log records one
 * row per state change or fault, at the moment it happened, with an electrical/state snapshot
 * attached. Both matter and neither substitutes for the other: during the Daylesford interruptions
 * of 17–18 September 2026 the portal's `fault_code` field read zero in all 126 successful samples
 * while these logs held codes 50, 127 and 128 with the DC voltages that explain them.
 *
 * Layout facts, established live against firmware 12.25 / events format 3 and traced offline in SP
 * LINK 16.11.9663 (`mRawDataDownload.fnDownloadEventData`, `clsEventRecord`):
 *
 * | What | Where |
 * | --- | --- |
 * | Alert log descriptor | 0xa266 (41574) |
 * | Operational log descriptor | 0xa2a7 (41639) |
 * | Record size | 36 words (72 bytes) |
 * | Scales block | 0xa028 (41000), 6 words |
 * | Device clock | 0x1d0000, 8 words, BCD |
 *
 * Both descriptors have the SAME shape as the detailed log's, so the ring walk is `ringMetadata`
 * plus `readBatches` from ./history.ts rather than a second implementation.
 *
 * This module stays free of database, network-framing and Clerk concerns: it takes a `MemoryReader`
 * and returns data. Storage lives in the app; see lib/diagnostics/.
 */
import { createHash } from "node:crypto";
import { type MemoryReader, wordsFrom } from "./protocol";
import { protocolError } from "./errors";
import {
  type LogMetadata,
  type RawRecord,
  deviceTime,
  readBatches,
  ringMetadata,
  timestampUtc,
  validateMetadata,
} from "./history";
import { known, label } from "./event-labels";

/** Bump when a decoded column's meaning or scaling changes. Stored with every capture, so a later
 * disagreement between two captures can be attributed to the decoder rather than the inverter. */
export const EVENT_DECODER_VERSION = 1;

export const EVENT_LOGS = {
  alert: 0xa266,
  operational: 0xa2a7,
} as const;
export type EventLog = keyof typeof EVENT_LOGS;
export const EVENT_LOG_NAMES = Object.keys(EVENT_LOGS) as EventLog[];
export const EVENT_RECORD_WORDS = 36;

export const supportedEventFormat = (version: number, words: number): boolean =>
  version === 3 && words === EVENT_RECORD_WORDS;

export async function eventLogMetadata(
  reader: MemoryReader,
  log: EventLog,
): Promise<LogMetadata> {
  const result = await ringMetadata(reader, EVENT_LOGS[log], `${log} log`);
  validateMetadata(result);
  return result;
}

// ---------------------------------------------------------------------------
// Scales and clock
// ---------------------------------------------------------------------------

/**
 * The installation's measurement scaling factors, read from the device.
 *
 * 🛑 These are NOT constants. The incident scripts that first read these logs carried
 * `av=5300, dv=1050, di=12000` as literals, which are this inverter's values and no one else's —
 * reused unchanged against another installation they would silently produce wrong volts and amps
 * rather than fail. Read them, store them with the capture, and pass them to the decoder.
 *
 * The event record carries its own copy of three of them (AC current, DC current, temperature) in
 * its last words. Those are preferred, because they are what the inverter was using when the
 * record was written; the block supplies the other two. Both are recorded.
 */
export interface EventScales {
  acVoltage: number;
  acCurrent: number;
  dcVoltage: number;
  dcCurrent: number;
  temperature: number;
  /** Sixth word of the block. Not yet identified; preserved rather than dropped. */
  reserved: number;
}
export const SCALES_ADDRESS = 0xa028;
export async function readScales(reader: MemoryReader): Promise<EventScales> {
  const w = wordsFrom(await reader.query(SCALES_ADDRESS, 6));
  const scales: EventScales = {
    acVoltage: w[0],
    acCurrent: w[1],
    dcVoltage: w[2],
    dcCurrent: w[3],
    temperature: w[4],
    reserved: w[5],
  };
  if (
    [
      scales.acVoltage,
      scales.acCurrent,
      scales.dcVoltage,
      scales.dcCurrent,
    ].some((v) => !v || v === 0xffff)
  )
    protocolError(
      "The inverter reported an empty or unavailable scaling block; event snapshots cannot be converted.",
    );
  return scales;
}

const bcd = (value: number) => (value >> 4) * 10 + (value & 15);

/**
 * The inverter's own clock, as an ALIGNMENT OBSERVATION.
 *
 * Every timestamp in an event log is a reading of this clock, and it drifts — measured about 45
 * seconds slow on 18 September 2026. `offsetSeconds` is host-minus-device at the moment of the
 * read, sampled at the midpoint of the round trip.
 *
 * 🛑 It is evidence about the clock, not a correction to apply. Original device timestamps are
 * stored verbatim; anything that wants an aligned time computes it and says so.
 */
export const CLOCK_ADDRESS = 0x1d0000;
export interface DeviceClock {
  address: number;
  hex: string;
  /** The device's own reading, its local clock, as YYYY-MM-DDTHH:MM:SS. */
  deviceTime: string;
  /** Host clock at the midpoint of the read, UTC. */
  observedAt: string;
  roundTripSeconds: number;
  /** Host minus device, seconds. Positive means the device is running slow. */
  offsetSeconds: number | null;
  /** The IANA zone used to interpret `deviceTime`, when the caller supplied one. */
  timezone?: string;
}
export async function readDeviceClock(
  reader: MemoryReader,
  timezone?: string,
): Promise<DeviceClock> {
  const startedMs = Date.now();
  const bytes = await reader.query(CLOCK_ADDRESS, 8);
  const finishedMs = Date.now();
  const w = wordsFrom(bytes);
  const century = (w[6] >> 7) * 100;
  const deviceTimeText =
    `${2000 + century + bcd(w[7])}`.padStart(4, "0") +
    `-${String(bcd(w[6] & 0x7f)).padStart(2, "0")}` +
    `-${String(bcd(w[5])).padStart(2, "0")}` +
    `T${String(bcd(w[3])).padStart(2, "0")}` +
    `:${String(bcd(w[2])).padStart(2, "0")}` +
    `:${String(bcd(w[1])).padStart(2, "0")}`;
  const midpointMs = startedMs + (finishedMs - startedMs) / 2;
  let offsetSeconds: number | null = null;
  if (timezone) {
    try {
      // timestampUtc rejects ambiguous/nonexistent local times rather than guessing; a clock read
      // that lands in a DST fold yields no offset rather than a wrong one.
      const deviceUtcMs = Date.parse(timestampUtc(deviceTimeText, timezone));
      offsetSeconds = (midpointMs - deviceUtcMs) / 1000;
    } catch {
      offsetSeconds = null;
    }
  }
  return {
    address: CLOCK_ADDRESS,
    hex: bytes.toString("hex"),
    deviceTime: deviceTimeText,
    observedAt: new Date(Math.round(midpointMs)).toISOString(),
    roundTripSeconds: (finishedMs - startedMs) / 1000,
    offsetSeconds,
    timezone,
  };
}

// ---------------------------------------------------------------------------
// Records and identity
// ---------------------------------------------------------------------------

export interface EventRecord extends RawRecord {
  log: EventLog;
  deviceSeconds: number;
  /** Device-local clock reading, YYYY-MM-DDTHH:MM:SS. */
  deviceTime: string;
}

/**
 * A record's stable identity, for deduplicating across overlapping captures.
 *
 * 🛑 NOT the address. The logs are ring buffers: an address is reused every time the ring wraps, so
 * two genuinely different events share one. Identity is the record's own bytes plus the log it came
 * from — which also makes re-reading the same record across two captures produce one row, which is
 * the entire point.
 */
export function eventRecordId(
  log: EventLog,
  deviceSeconds: number,
  hex: string,
): string {
  const digest = createHash("sha256").update(hex).digest("hex").slice(0, 16);
  return `i:${log}:${deviceSeconds}:${digest}`;
}

export const toEventRecord = (
  log: EventLog,
  address: number,
  hex: string,
): EventRecord => {
  const seconds = Buffer.from(hex, "hex").readUInt32LE(0);
  return {
    log,
    address,
    hex,
    deviceSeconds: seconds,
    deviceTime: deviceTime(seconds),
  };
};

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const signed16 = (value: number) => (value >= 0x8000 ? value - 0x10000 : value);

export interface DecodedEvent {
  id: string;
  log: EventLog;
  address: number;
  device_seconds_since_2001: number;
  device_time: string;
  code: number;
  description: string;
  code_known: boolean;
  dc_voltage_v: number;
  dc_mid_voltage_v: number;
  inverter_dc_current_a: number;
  shunt1_current_a: number;
  shunt2_current_a: number;
  load_ac_power_kw: number;
  inverter_ac_power_kw: number;
  ac_input_power_kw: number;
  ac_load_voltage_v: number;
  ac_load_frequency_hz: number;
  state_of_charge_percent: number | null;
  inverter_mode_code: number;
  inverter_mode: string;
  charger_status_code: number;
  charger_status: string;
  contactor_state_code: number;
  contactor_state: string;
  generator_status_code: number;
  generator_status: string;
  generator_start_reason_code: number;
  generator_start_reason: string;
  generator_run_reason_code: number;
  generator_run_reason: string;
  /** Scale factors actually used, so a later re-decode is comparable. */
  scale_ac_voltage: number;
  scale_ac_current: number;
  scale_dc_voltage: number;
  scale_dc_current: number;
  /** Set when the snapshot's DC volts AND AC load volts are both zero, which is what a record
   * written during reset initialisation looks like. Zeros there are missing data, not a measured
   * zero — the caution the incident analysis carried, kept rather than re-learned. */
  snapshot_suspect: boolean;
  raw_hex: string;
  raw_words: number[];
}

/**
 * Decode one 36-word event record.
 *
 * Conversion facts traced from SP LINK 16.11.9663 (`clsEventRecord`) and validated against the
 * September 2026 acquisitions. Words 16–21, 28–31 and 33 have no established meaning and are kept
 * in `raw_words` rather than guessed at.
 */
export function decodeEventRecord(
  record: EventRecord,
  scales: EventScales,
): DecodedEvent {
  const bytes = Buffer.from(record.hex, "hex");
  if (bytes.length / 2 !== EVENT_RECORD_WORDS)
    protocolError("Unsupported event record length.");
  const w = wordsFrom(bytes);
  const s = (i: number) => signed16(w[i]);
  // The record's own tail wins over the device-wide block: it is what the inverter was using when
  // this row was written. Only AC voltage has no per-record copy.
  const ai = w[32] || scales.acCurrent;
  const di = w[34] || scales.dcCurrent;
  const av = scales.acVoltage;
  const dv = scales.dcVoltage;
  const code = w[2];
  const set = record.log === "alert" ? "alertEvent" : "operationalEvent";
  const description = label(set, code);
  return {
    id: eventRecordId(record.log, record.deviceSeconds, record.hex),
    log: record.log,
    address: record.address,
    device_seconds_since_2001: record.deviceSeconds,
    device_time: record.deviceTime,
    code,
    description,
    code_known: known(set, code),
    dc_voltage_v: (s(3) * dv) / 327680,
    dc_mid_voltage_v: (s(4) * dv) / 327680,
    inverter_dc_current_a: (s(5) * di) / 327680,
    shunt1_current_a: (s(6) * di) / 327680,
    shunt2_current_a: (s(7) * di) / 327680,
    load_ac_power_kw: (bytes.readInt32LE(16) * av * ai) / 26214400000,
    inverter_ac_power_kw: (bytes.readInt32LE(20) * av * ai) / 26214400000,
    ac_input_power_kw: (s(12) * av * ai) / 3276800000,
    ac_load_voltage_v: (s(13) * av) / 327680,
    ac_load_frequency_hz: s(15) / 100,
    state_of_charge_percent: w[14] === 0xffff ? null : w[14] / 256,
    inverter_mode_code: w[22],
    inverter_mode: label("inverterMode", w[22]),
    charger_status_code: w[23],
    charger_status: label("chargerStatus", w[23]),
    contactor_state_code: w[24],
    contactor_state: label("contactorState", w[24]),
    generator_status_code: w[25],
    generator_status: label("generatorStatus", w[25]),
    generator_start_reason_code: w[26],
    generator_start_reason: label("generatorReason", w[26]),
    generator_run_reason_code: w[27],
    generator_run_reason: label("generatorReason", w[27]),
    scale_ac_voltage: av,
    scale_ac_current: ai,
    scale_dc_voltage: dv,
    scale_dc_current: di,
    snapshot_suspect: w[3] === 0 && w[13] === 0,
    raw_hex: record.hex,
    raw_words: w,
  };
}

export const EVENT_CSV_COLUMNS = [
  "log",
  "device_time",
  "device_seconds_since_2001",
  "code",
  "description",
  "code_known",
  "dc_voltage_v",
  "dc_mid_voltage_v",
  "inverter_dc_current_a",
  "shunt1_current_a",
  "shunt2_current_a",
  "load_ac_power_kw",
  "inverter_ac_power_kw",
  "ac_input_power_kw",
  "ac_load_voltage_v",
  "ac_load_frequency_hz",
  "state_of_charge_percent",
  "inverter_mode",
  "charger_status",
  "contactor_state",
  "generator_status",
  "generator_start_reason",
  "generator_run_reason",
  "snapshot_suspect",
  "address",
  "id",
  "raw_hex",
] as const;

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

/** The newest record a previous capture holds, for an incremental read. */
export interface EventAnchor {
  deviceSeconds: number;
  id: string;
}

export interface AcquireEventsOptions {
  /** Stop once this record is seen again — the previous capture's newest. */
  since?: EventAnchor;
  /** Stop after reading one record older than this device-local time (YYYY-MM-DDTHH:MM:SS). */
  sinceDeviceTime?: string;
  /** Wall-clock budget for the walk. Exceeding it yields a partial, explicitly incomplete result. */
  deadlineMs?: number;
  signal?: AbortSignal;
  onProgress?: (records: number, advertised: number) => void;
}

export interface EventAcquisition {
  log: EventLog;
  before: LogMetadata;
  after: LogMetadata | null;
  records: EventRecord[];
  /** Every advertised record was read and nothing moved underneath the walk. */
  complete: boolean;
  metadataStable: boolean;
  newestAnchorStable: boolean;
  oldestAnchorStable: boolean;
  /** An incremental read was requested. */
  incremental: boolean;
  /** …and the anchor record was actually seen again. */
  overlapObserved: boolean;
  /**
   * What the overlap check ACTUALLY established. The three failing cases are not one finding:
   *
   *   `confirmed`  the anchor was seen again — nothing was missed between the two captures.
   *   `lost`       the whole retained ring was walked and the anchor was NOT in it. The records
   *                between are gone from the inverter for good.
   *   `unverified` the walk stopped early (deadline, abort, error) before reaching the anchor.
   *                This says nothing about whether those records still exist — retry.
   *
   * 🛑 Collapsing `unverified` into `lost` asserts permanent data loss on no evidence, which is
   * exactly what a bounded 40-second acquisition produces when a site is in trouble.
   */
  overlapVerdict: "not-incremental" | "confirmed" | "lost" | "unverified";
  stoppedBecause:
    | "exhausted"
    | "overlap"
    | "since-device-time"
    | "deadline"
    | "aborted"
    | "error";
  earliestDeviceTime: string | null;
  latestDeviceTime: string | null;
  error?: string;
}

/**
 * Walk one event log newest-first.
 *
 * The completeness discipline is the incident scripts', which is the only version of it that has
 * been exercised against a live inverter: capture the descriptor and the newest record BEFORE the
 * walk, re-read both afterwards along with the oldest record actually read, and report each
 * comparison separately. A moving buffer is reported, never silently accepted — and never silently
 * rejected either, because a partial capture of a fault that is happening right now is still the
 * best evidence available.
 */
export async function acquireEventLog(
  reader: MemoryReader,
  log: EventLog,
  options: AcquireEventsOptions = {},
): Promise<EventAcquisition> {
  const before = await eventLogMetadata(reader, log);
  if (before.entryWords !== EVENT_RECORD_WORDS)
    protocolError(
      `The ${log} log advertises ${before.entryWords}-word records; this layout is unsupported.`,
    );
  const result: EventAcquisition = {
    log,
    before,
    after: null,
    records: [],
    complete: false,
    metadataStable: false,
    newestAnchorStable: false,
    oldestAnchorStable: false,
    incremental: Boolean(options.since),
    overlapObserved: false,
    overlapVerdict: options.since ? "unverified" : "not-incremental",
    stoppedBecause: "exhausted",
    earliestDeviceTime: null,
    latestDeviceTime: null,
  };
  if (!before.recordCount) {
    result.after = await eventLogMetadata(reader, log);
    result.metadataStable =
      JSON.stringify(before) === JSON.stringify(result.after);
    result.complete = result.metadataStable;
    result.newestAnchorStable = true;
    result.oldestAnchorStable = true;
    // An EMPTY ring that we were asked to resume into IS a real loss: the anchor we hold is not
    // there, and there was nothing left to walk.
    if (options.since && result.metadataStable) result.overlapVerdict = "lost";
    return result;
  }
  const anchorBefore = await reader.query(
    before.currentAddress,
    before.entryWords,
  );
  const records = result.records;
  try {
    walk: for (const batch of readBatches(before)) {
      if (options.signal?.aborted) {
        result.stoppedBecause = "aborted";
        break;
      }
      if (options.deadlineMs && Date.now() > options.deadlineMs) {
        result.stoppedBecause = "deadline";
        break;
      }
      const bytes = await reader.query(batch.address, batch.words);
      if (bytes.length !== batch.words * 2)
        protocolError(`Incomplete ${log} log batch.`);
      for (let i = batch.records - 1; i >= 0; i--) {
        const hex = bytes
          .subarray(i * before.entryWords * 2, (i + 1) * before.entryWords * 2)
          .toString("hex");
        const record = toEventRecord(
          log,
          batch.address + i * before.entryWords,
          hex,
        );
        records.push(record);
        if (
          options.since &&
          eventRecordId(log, record.deviceSeconds, hex) === options.since.id
        ) {
          // Include the anchor: its presence is the PROOF that nothing was missed between the two
          // captures. The caller deduplicates it away.
          result.overlapObserved = true;
          result.overlapVerdict = "confirmed";
          result.stoppedBecause = "overlap";
          break walk;
        }
        if (
          options.sinceDeviceTime &&
          record.deviceTime < options.sinceDeviceTime
        ) {
          result.stoppedBecause = "since-device-time";
          break walk;
        }
      }
      options.onProgress?.(records.length, before.recordCount);
    }
    result.after = await eventLogMetadata(reader, log);
    result.metadataStable =
      JSON.stringify(before) === JSON.stringify(result.after);
    if (records.length) {
      const newestAgain = await reader.query(
        records[0].address,
        before.entryWords,
      );
      const oldestAgain = await reader.query(
        records[records.length - 1].address,
        before.entryWords,
      );
      result.newestAnchorStable =
        anchorBefore.toString("hex") === records[0].hex &&
        newestAgain.toString("hex") === records[0].hex;
      result.oldestAnchorStable =
        oldestAgain.toString("hex") === records[records.length - 1].hex;
    }
    result.complete =
      result.metadataStable &&
      result.newestAnchorStable &&
      result.oldestAnchorStable &&
      (result.stoppedBecause === "exhausted"
        ? records.length === before.recordCount
        : result.stoppedBecause === "overlap" ||
          result.stoppedBecause === "since-device-time");
    // Only a walk that reached the END of the retained ring can say the anchor is GONE. Any other
    // stop leaves the question open, and `unverified` is the honest answer.
    if (
      options.since &&
      !result.overlapObserved &&
      result.stoppedBecause === "exhausted" &&
      result.complete
    )
      result.overlapVerdict = "lost";
  } catch (error) {
    result.stoppedBecause = "error";
    result.error =
      error instanceof Error ? error.message : "Event acquisition failed.";
  }
  const times = records.map((r) => r.deviceTime).sort();
  result.earliestDeviceTime = times[0] ?? null;
  result.latestDeviceTime = times[times.length - 1] ?? null;
  return result;
}
