import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseDateTime, toZoned } from "@internationalized/date";
import { type MemoryReader, type DeviceInfo, wordsFrom } from "./protocol";
import { SelectLiveError, protocolError } from "./errors";

export const EPOCH_MS = Date.UTC(2001, 0, 1);
export interface Sector {
  start: number;
  end: number;
}
export interface LogMetadata {
  sectorCount: number;
  entryWords: number;
  currentAddress: number;
  recordCount: number;
  sectors: Sector[];
  intervalMinutes: number;
}
export async function logMetadata(reader: MemoryReader): Promise<LogMetadata> {
  const data = await reader.query(0xa335, 5);
  const sectorCount = data.readUInt16LE(0);
  if (sectorCount > 64)
    protocolError(
      "Detailed log advertises more than 64 sectors; this layout is unsupported.",
    );
  const sectors: Sector[] = [];
  if (sectorCount) {
    const ranges = await reader.query(0xa33a, sectorCount * 4);
    for (let i = 0; i < sectorCount; i++)
      sectors.push({
        start: ranges.readUInt32LE(i * 8),
        end: ranges.readUInt32LE(i * 8 + 4),
      });
  }
  const result: LogMetadata = {
    sectorCount,
    entryWords: data.readUInt16LE(2),
    currentAddress: data.readUInt32LE(4),
    recordCount: data.readUInt16LE(8),
    sectors,
    intervalMinutes: (await reader.query(0xc036, 1)).readUInt16LE(0),
  };
  validateMetadata(result);
  return result;
}
export function validateMetadata(log: LogMetadata): void {
  if (log.sectorCount !== log.sectors.length)
    protocolError("Sector count does not match the sector table.");
  if (log.recordCount === 0 && log.sectorCount === 0) return;
  if (
    !Number.isInteger(log.entryWords) ||
    log.entryWords < 1 ||
    log.entryWords > 256
  )
    protocolError("Unsupported detailed record size.");
  let capacity = 0;
  for (let i = 0; i < log.sectors.length; i++) {
    const { start, end } = log.sectors[i];
    if (
      ![start, end].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff,
      ) ||
      end < start ||
      end - start + 1 < log.entryWords
    )
      protocolError("Invalid log sector bounds.");
    if (log.sectors.slice(0, i).some((s) => start <= s.end && end >= s.start))
      protocolError("Overlapping log sectors.");
    capacity += Math.floor((end - start + 1) / log.entryWords);
  }
  if (
    !Number.isInteger(log.recordCount) ||
    log.recordCount < 0 ||
    log.recordCount > Math.min(capacity, 65535)
  )
    protocolError("Log count exceeds the advertised buffer capacity.");
  if (
    log.recordCount &&
    !log.sectors.some(
      (s) =>
        log.currentAddress >= s.start &&
        log.currentAddress + log.entryWords - 1 <= s.end &&
        (log.currentAddress - s.start) % log.entryWords === 0,
    )
  )
    protocolError(
      "Current log address is not an aligned record within a sector.",
    );
}
export function* readBatches(
  log: LogMetadata,
): Generator<{ address: number; words: number; records: number }> {
  validateMetadata(log);
  if (!log.recordCount) return;
  let sector = log.sectors.findIndex(
    (s) => log.currentAddress >= s.start && log.currentAddress <= s.end,
  );
  let current = log.currentAddress;
  let remaining = log.recordCount;
  while (remaining > 0) {
    const count = Math.min(
      remaining,
      Math.floor(256 / log.entryWords),
      Math.floor((current - log.sectors[sector].start) / log.entryWords) + 1,
    );
    const address = current - (count - 1) * log.entryWords;
    yield { address, words: count * log.entryWords, records: count };
    remaining -= count;
    current = address - log.entryWords;
    if (current < log.sectors[sector].start) {
      sector = (sector + log.sectors.length - 1) % log.sectors.length;
      const range = log.sectors[sector];
      current =
        range.start +
        (Math.floor((range.end - range.start + 1) / log.entryWords) - 1) *
          log.entryWords;
    }
  }
}
export interface RawRecord {
  address: number;
  hex: string;
}
export const supportedFormat = (version: number, words: number): boolean =>
  [1, 2, 3].includes(version) && words === 44;
export function deviceTime(seconds: number): string {
  return new Date(EPOCH_MS + seconds * 1000).toISOString().slice(0, 19);
}
export function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new SelectLiveError(
      "usage",
      "--timezone must be a valid IANA timezone, for example Australia/Melbourne.",
    );
  }
}
export function timestampUtc(local: string, timezone: string): string {
  // Device timestamps are clock readings, not UTC. Refuse ambiguous/nonexistent DST times.
  try {
    return toZoned(parseDateTime(local), timezone, "reject")
      .toDate()
      .toISOString();
  } catch {
    throw new SelectLiveError(
      "protocol",
      "A device timestamp is ambiguous or nonexistent in the requested timezone; raw data has been preserved.",
    );
  }
}
const signed16 = (value: number) => (value >= 0x8000 ? value - 0x10000 : value);
export interface DecodedRecord {
  device_seconds_since_2001: number;
  device_time: string;
  timestamp_utc: string;
  [column: string]: number | string | null;
}
/** Conversion facts traced from SP LINK 16.11.9663, clsShortTermRecord.
 * Keep native signs and precision; CSV formatting in SP LINK rounds most fields to 2 places.
 */
export function decodeRecord(
  record: RawRecord,
  version: number,
  timezone: string,
): DecodedRecord {
  const bytes = Buffer.from(record.hex, "hex");
  if (!supportedFormat(version, bytes.length / 2))
    protocolError("Unsupported detailed log format or record length.");
  const w = wordsFrom(bytes);
  const seconds = bytes.readUInt32LE(0);
  if (
    seconds === 0xffffffff ||
    w.slice(-5).some((v) => v === 0 || v === 0xffff)
  )
    protocolError("Invalid detailed log timestamp or scaling factors.");
  const [av, ai, dv, di, temperature] = w.slice(-5);
  const dcV = (i: number) => (signed16(w[i]) * dv) / 327680;
  const dcI = (i: number) => (signed16(w[i]) * di) / 327680;
  const acP = (i: number) => (signed16(w[i]) * av * ai) / 3276800000;
  const acE = (i: number) => (w[i] * 24 * av * ai) / 3276800000;
  const dcE = (i: number) => (signed16(w[i]) * 24 * dv * di) / 3276800000;
  const dcE32 = (i: number) =>
    (bytes.readUInt32LE(i * 2) * 24 * dv * di) / 3276800000;
  const temp = (i: number) =>
    w[i] === 0x7fff ? null : (signed16(w[i]) * temperature) / 32768;
  const local = deviceTime(seconds);
  return {
    device_seconds_since_2001: seconds,
    device_time: local,
    timestamp_utc: timestampUtc(local, timezone),
    inverter_ac_power_average_kw:
      (bytes.readInt32LE(4) * av * ai) / 26214400000,
    dc_input_accumulated_kwh: dcE32(4),
    dc_output_accumulated_kwh: dcE32(6),
    battery_in_accumulated_kwh: dcE32(8),
    battery_out_accumulated_kwh: dcE32(10),
    dc_voltage_average_v: dcV(12),
    dc_voltage_min_v: dcV(13),
    dc_voltage_max_v: dcV(14),
    dc_mid_voltage_average_v: dcV(15),
    dc_mid_voltage_at_min_v: dcV(16),
    dc_mid_voltage_at_max_v: dcV(17),
    inverter_dc_current_average_a: dcI(18),
    shunt1_current_average_a: dcI(19),
    shunt2_current_average_a: dcI(20),
    load_ac_power_average_kw: acP(21),
    load_ac_power_max_kw: acP(22),
    ac_input_power_average_kw: acP(23),
    ac_load_voltage_average_v: (signed16(w[24]) * av) / 327680,
    ac_load_frequency_average_hz: signed16(w[25]) / 100,
    transformer_temperature_max_c: temp(26),
    heatsink_temperature_max_c: temp(27),
    battery_temperature_max_c: temp(28),
    internal_temperature_max_c: version < 3 ? temp(29) : null,
    power_module_temperature_max_c: version < 3 ? temp(30) : null,
    state_of_charge_percent: w[31] === 0xffff ? null : w[31] / 256,
    ac_input_accumulated_kwh: acE(32),
    ac_load_accumulated_kwh: acE(33),
    shunt1_accumulated_kwh: dcE(34),
    shunt2_accumulated_kwh: dcE(35),
    analogue_input1_voltage_average_v: dcV(36),
    analogue_input2_voltage_average_v: dcV(37),
    ac_export_accumulated_kwh: acE(38),
    ac_coupled_power_average_kw:
      version >= 3 && w[29] !== 0xffff ? acP(29) : null,
    ac_coupled_energy_sample_kwh:
      version >= 3 && w[30] !== 0xffff ? acE(30) : null,
  };
}
export function coverage(
  records: RawRecord[],
): { earliestDeviceTime: string; latestDeviceTime: string } | null {
  const times = records
    .filter((r) => r.hex.length >= 8)
    .map((r) => Buffer.from(r.hex, "hex").readUInt32LE(0))
    .filter((s) => s !== 0xffffffff);
  return times.length
    ? {
        earliestDeviceTime: deviceTime(Math.min(...times)),
        latestDeviceTime: deviceTime(Math.max(...times)),
      }
    : null;
}
export interface DownloadOptions {
  out: string;
  timezone?: string;
  start?: string;
  end?: string;
  signal?: AbortSignal;
  progress?: (records: number, total: number) => void;
}
export interface Acquisition {
  version: 1;
  directory: string;
  device: DeviceInfo;
  startedAt: string;
  finishedAt?: string;
  before: LogMetadata;
  after?: LogMetadata;
  complete: boolean;
  acquiredRecords: number;
  coverage: ReturnType<typeof coverage>;
  decoding: string;
  csvRows?: number;
  timezone?: string;
  filter: { start?: string; end?: string };
  error?: string;
  rawSha256?: string;
}
export function validateDownloadOptions(options: DownloadOptions): void {
  if (options.timezone) validateTimezone(options.timezone);
  if ((options.start || options.end) && !options.timezone)
    throw new SelectLiveError("usage", "Date filtering requires --timezone.");
  for (const date of [options.start, options.end]) {
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
  }
  if (options.start && options.end && options.start >= options.end)
    throw new SelectLiveError(
      "usage",
      "--start must be before the exclusive --end date.",
    );
}
export async function downloadHistory(
  reader: MemoryReader,
  device: DeviceInfo,
  options: DownloadOptions,
): Promise<Acquisition> {
  validateDownloadOptions(options);
  const before = await logMetadata(reader);
  fs.mkdirSync(options.out, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(path.resolve(options.out), `selectlive-${device.serial}-`),
  );
  const manifest: Acquisition = {
    version: 1,
    directory,
    device,
    startedAt: new Date().toISOString(),
    before,
    complete: false,
    acquiredRecords: 0,
    coverage: null,
    decoding: "pending",
    timezone: options.timezone,
    filter: { start: options.start, end: options.end },
  };
  const manifestPath = path.join(directory, "manifest.json");
  const writeManifest = () => {
    fs.writeFileSync(
      `${manifestPath}.tmp`,
      JSON.stringify(manifest, null, 2) + "\n",
    );
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  };
  writeManifest();
  const rawPath = path.join(directory, "records.jsonl");
  const fd = fs.openSync(rawPath, "wx", 0o600);
  const records: RawRecord[] = [];
  const hash = createHash("sha256");
  try {
    let lastCheckpoint = Date.now();
    for (const batch of readBatches(before)) {
      if (options.signal?.aborted)
        throw new SelectLiveError("interrupted", "Operation interrupted.");
      const bytes = await reader.query(batch.address, batch.words);
      if (bytes.length !== batch.words * 2)
        protocolError("Incomplete history batch.");
      for (let i = batch.records - 1; i >= 0; i--) {
        const record = {
          address: batch.address + i * before.entryWords,
          hex: bytes
            .subarray(
              i * before.entryWords * 2,
              (i + 1) * before.entryWords * 2,
            )
            .toString("hex"),
        };
        const line = JSON.stringify(record) + "\n";
        fs.writeSync(fd, line);
        hash.update(line);
        records.push(record);
      }
      manifest.acquiredRecords = records.length;
      options.progress?.(records.length, before.recordCount);
      if (Date.now() - lastCheckpoint > 5000) {
        writeManifest();
        lastCheckpoint = Date.now();
      }
    }
    if (options.signal?.aborted)
      throw new SelectLiveError("interrupted", "Operation interrupted.");
    manifest.after = await logMetadata(reader);
    if (JSON.stringify(before) !== JSON.stringify(manifest.after))
      protocolError(
        "Log metadata changed during acquisition; this download is incomplete. Retry to acquire a stable snapshot.",
      );
    // Also detect replacement at the current slot even if a counter/address returned to its old value.
    if (records.length) {
      const anchor = await reader.query(records[0].address, before.entryWords);
      if (anchor.toString("hex") !== records[0].hex)
        protocolError(
          "The newest log record changed during acquisition; this download is incomplete.",
        );
    }
    manifest.complete = records.length === before.recordCount;
  } catch (error) {
    manifest.error =
      error instanceof SelectLiveError
        ? error.message
        : "History acquisition failed.";
    manifest.decoding = "not_attempted_incomplete";
  } finally {
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    manifest.finishedAt = new Date().toISOString();
    manifest.rawSha256 = hash.digest("hex");
    manifest.acquiredRecords = records.length;
    manifest.coverage = supportedFormat(
      device.versions.detailed,
      before.entryWords,
    )
      ? coverage(records)
      : null;
    writeManifest();
  }
  if (manifest.complete) {
    if (
      !supportedFormat(device.versions.detailed, before.entryWords) &&
      records.length
    )
      manifest.decoding = "unsupported_format";
    else if (!options.timezone) manifest.decoding = "timezone_required";
    else {
      try {
        const start = options.start
          ? timestampUtc(`${options.start}T00:00:00`, options.timezone)
          : undefined;
        const end = options.end
          ? timestampUtc(`${options.end}T00:00:00`, options.timezone)
          : undefined;
        const decoded = records
          .map((r) =>
            decodeRecord(r, device.versions.detailed, options.timezone!),
          )
          .filter(
            (r) =>
              (!start || r.timestamp_utc >= start) &&
              (!end || r.timestamp_utc < end),
          )
          .sort((a, b) => a.timestamp_utc.localeCompare(b.timestamp_utc));
        // Even an empty download has the stable CSV schema.
        const columns = [...CSV_COLUMNS];
        const cell = (v: unknown) =>
          v == null ? "" : `"${String(v).replace(/"/g, '""')}"`;
        const csv =
          [
            columns.join(","),
            ...decoded.map((r) => columns.map((c) => cell(r[c])).join(",")),
          ].join("\n") + "\n";
        fs.writeFileSync(path.join(directory, "detailed.csv"), csv, {
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

export const CSV_COLUMNS = [
  "device_seconds_since_2001",
  "device_time",
  "timestamp_utc",
  "inverter_ac_power_average_kw",
  "dc_input_accumulated_kwh",
  "dc_output_accumulated_kwh",
  "battery_in_accumulated_kwh",
  "battery_out_accumulated_kwh",
  "dc_voltage_average_v",
  "dc_voltage_min_v",
  "dc_voltage_max_v",
  "dc_mid_voltage_average_v",
  "dc_mid_voltage_at_min_v",
  "dc_mid_voltage_at_max_v",
  "inverter_dc_current_average_a",
  "shunt1_current_average_a",
  "shunt2_current_average_a",
  "load_ac_power_average_kw",
  "load_ac_power_max_kw",
  "ac_input_power_average_kw",
  "ac_load_voltage_average_v",
  "ac_load_frequency_average_hz",
  "transformer_temperature_max_c",
  "heatsink_temperature_max_c",
  "battery_temperature_max_c",
  "internal_temperature_max_c",
  "power_module_temperature_max_c",
  "state_of_charge_percent",
  "ac_input_accumulated_kwh",
  "ac_load_accumulated_kwh",
  "shunt1_accumulated_kwh",
  "shunt2_accumulated_kwh",
  "analogue_input1_voltage_average_v",
  "analogue_input2_voltage_average_v",
  "ac_export_accumulated_kwh",
  "ac_coupled_power_average_kw",
  "ac_coupled_energy_sample_kwh",
] as const;
