import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  coverage,
  decodeRecord,
  deviceTime,
  downloadHistory,
  EPOCH_MS,
  logMetadata,
  readBatches,
  timestampUtc,
  validateDownloadOptions,
  validateMetadata,
  type LogMetadata,
} from "../history";
import type { DeviceInfo, MemoryReader } from "../protocol";

const device: DeviceInfo = {
  serial: "123",
  modelCode: 1,
  firmware: "16.11",
  firmwareRaw: 1611,
  versions: {
    configuration: 51,
    service: 15,
    memoryMap: 33,
    events: 3,
    detailed: 3,
    daily: 5,
  },
};
const log: LogMetadata = {
  sectorCount: 2,
  entryWords: 44,
  currentAddress: 2044,
  recordCount: 5,
  sectors: [
    { start: 1000, end: 1138 },
    { start: 2000, end: 2138 },
  ],
  intervalMinutes: 15,
};
const seconds = (date: string) => (Date.parse(date + "Z") - EPOCH_MS) / 1000;
function record(date: string): Buffer {
  const b = Buffer.alloc(88);
  b.writeUInt32LE(seconds(date));
  b.writeInt32LE(8000, 4);
  b.writeUInt16LE(1000, 24); // average DC voltage => 50 V
  b.writeInt16LE(-100, 36); // signed inverter current
  b.writeInt16LE(-100, 42); // load power => -1 kW (native CSV sign)
  b.writeUInt16LE(5000, 50); // 50 Hz
  b.writeUInt16LE(0x7fff, 52); // missing transformer temperature
  b.writeUInt16LE(100, 58); // v3 solar power => 1 kW
  b.writeUInt16LE(2, 60); // v3 solar energy => 0.48 kWh
  b.writeUInt16LE(50 * 256, 62);
  [32768, 1000, 16384, 2000, 100].forEach((v, i) =>
    b.writeUInt16LE(v, (39 + i) * 2),
  );
  return b;
}
function memory(meta = log, mutate = false): MemoryReader {
  let metadataReads = 0;
  const records = new Map([
    [1000, record("2026-09-09T23:45:00")],
    [1044, record("2026-09-10T00:00:00")],
    [1088, record("2026-09-10T00:15:00")],
    [2000, record("2026-09-10T00:30:00")],
    [2044, record("2026-09-11T00:00:00")],
  ]);
  return {
    async query(address, words) {
      if (address === 0xa335) {
        const b = Buffer.alloc(10);
        b.writeUInt16LE(meta.sectorCount);
        b.writeUInt16LE(meta.entryWords, 2);
        b.writeUInt32LE(
          meta.currentAddress + (mutate && metadataReads++ > 0 ? 44 : 0),
          4,
        );
        b.writeUInt16LE(meta.recordCount, 8);
        return b;
      }
      if (address === 0xa33a) {
        const b = Buffer.alloc(meta.sectors.length * 8);
        meta.sectors.forEach((s, i) => {
          b.writeUInt32LE(s.start, i * 8);
          b.writeUInt32LE(s.end, i * 8 + 4);
        });
        return b;
      }
      if (address === 0xc036) return Buffer.from([15, 0]);
      const result = Buffer.alloc(words * 2);
      for (let offset = 0; offset < words; offset += 44) {
        const r = records.get(address + offset);
        if (!r) throw new Error("Unexpected memory read");
        r.copy(result, offset * 2, 0, Math.min(88, result.length - offset * 2));
      }
      return result;
    },
  };
}
let out: string;
beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), "selectlive-history-test-"));
});
afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

it("reads the five-word metadata header and walks backwards through sector wrap and padding", async () => {
  expect(await logMetadata(memory())).toEqual(log);
  expect([...readBatches(log)]).toEqual([
    { address: 2000, words: 88, records: 2 },
    { address: 1000, words: 132, records: 3 },
  ]);
  expect(() => validateMetadata({ ...log, currentAddress: 2045 })).toThrow(
    /aligned/,
  );
  expect(() => validateMetadata({ ...log, recordCount: 7 })).toThrow(
    /capacity/,
  );
  expect(() =>
    validateMetadata({ ...log, sectors: [log.sectors[0], log.sectors[0]] }),
  ).toThrow(/Overlapping/);
});
it("decodes the 2001 epoch, native signed values, scale factors and format 3 solar fields", () => {
  const row = decodeRecord(
    { address: 1000, hex: record("2026-09-10T00:00:00").toString("hex") },
    3,
    "Australia/Melbourne",
  );
  expect(deviceTime(0)).toBe("2001-01-01T00:00:00");
  expect(row.timestamp_utc).toBe("2026-09-09T14:00:00.000Z");
  expect(row.dc_voltage_average_v).toBe(50);
  expect(row.inverter_ac_power_average_kw).toBe(10);
  expect(row.load_ac_power_average_kw).toBe(-1);
  expect(row.inverter_dc_current_average_a).toBeCloseTo(-0.6103515625);
  expect(row.ac_load_frequency_average_hz).toBe(50);
  expect(row.state_of_charge_percent).toBe(50);
  expect(row.transformer_temperature_max_c).toBeNull();
  expect(row.internal_temperature_max_c).toBeNull();
  expect(row.ac_coupled_power_average_kw).toBe(1);
  expect(row.ac_coupled_energy_sample_kwh).toBe(0.48);
});
it("keeps old temperature fields and recognises absent SOC/solar readings", () => {
  const bytes = record("2026-09-10T00:00:00");
  const old = decodeRecord(
    { address: 1, hex: bytes.toString("hex") },
    2,
    "UTC",
  );
  expect(old.internal_temperature_max_c).toBeCloseTo((100 * 100) / 32768);
  expect(old.ac_coupled_power_average_kw).toBeNull();
  [29, 30, 31].forEach((i) => bytes.writeUInt16LE(65535, i * 2));
  const row = decodeRecord(
    { address: 1, hex: bytes.toString("hex") },
    3,
    "UTC",
  );
  expect(row.state_of_charge_percent).toBeNull();
  expect(row.ac_coupled_power_average_kw).toBeNull();
  expect(row.ac_coupled_energy_sample_kwh).toBeNull();
});
it("rejects ambiguous/nonexistent timezone conversions and invalid filters", () => {
  expect(() =>
    timestampUtc("2026-04-05T02:30:00", "Australia/Melbourne"),
  ).toThrow(/ambiguous/);
  expect(() =>
    timestampUtc("2026-10-04T02:30:00", "Australia/Melbourne"),
  ).toThrow(/nonexistent/);
  expect(() => validateDownloadOptions({ out, start: "2026-09-10" })).toThrow(
    /timezone/,
  );
  expect(() => validateDownloadOptions({ out, timezone: "wrong" })).toThrow(
    /IANA/,
  );
  expect(() =>
    validateDownloadOptions({ out, timezone: "UTC", start: "2026-02-30" }),
  ).toThrow(/valid ISO/);
  expect(() =>
    validateDownloadOptions({
      out,
      timezone: "UTC",
      start: "2026-09-10",
      end: "2026-09-10",
    }),
  ).toThrow(/before/);
});
it("preserves all raw records before local filtering and never overwrites a previous acquisition", async () => {
  const opts = {
    out,
    timezone: "Australia/Melbourne",
    start: "2026-09-10",
    end: "2026-09-11",
  };
  const result = await downloadHistory(memory(), device, opts);
  expect(result).toMatchObject({
    complete: true,
    acquiredRecords: 5,
    decoding: "decoded",
    csvRows: 3,
  });
  const raw = fs
    .readFileSync(path.join(result.directory, "records.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(raw.map((r) => r.address)).toEqual([2044, 2000, 1088, 1044, 1000]);
  expect(coverage(raw)?.earliestDeviceTime).toBe("2026-09-09T23:45:00");
  expect(result.rawSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(
    fs
      .readFileSync(path.join(result.directory, "detailed.csv"), "utf8")
      .trim()
      .split("\n"),
  ).toHaveLength(4);
  const again = await downloadHistory(memory(), device, opts);
  expect(again.directory).not.toBe(result.directory);
  expect(fs.existsSync(path.join(result.directory, "detailed.csv"))).toBe(true);
});
it.each(["moving", "disconnect", "interrupt"])(
  "preserves an explicit incomplete acquisition for %s",
  async (kind) => {
    const reader = memory(log, kind === "moving");
    const controller = new AbortController();
    let batches = 0;
    const original = reader.query.bind(reader);
    reader.query = async (address, words) => {
      if (address < 40960 && ++batches === 2 && kind === "disconnect")
        throw new Error("simulated connection error with secret");
      return original(address, words);
    };
    const result = await downloadHistory(reader, device, {
      out,
      timezone: "UTC",
      signal: controller.signal,
      progress: () => {
        if (kind === "interrupt") controller.abort();
      },
    });
    expect(result.complete).toBe(false);
    expect(result.decoding).toBe("not_attempted_incomplete");
    expect(result.acquiredRecords).toBeGreaterThan(0);
    expect(result.error).not.toContain("secret");
    expect(fs.existsSync(path.join(result.directory, "detailed.csv"))).toBe(
      false,
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(result.directory, "manifest.json"), "utf8"),
      ).complete,
    ).toBe(false);
  },
);
it("retains unknown formats and downloads without a timezone without inventing CSV", async () => {
  const unknown = await downloadHistory(
    memory(),
    { ...device, versions: { ...device.versions, detailed: 4 } },
    { out, timezone: "UTC" },
  );
  expect(unknown).toMatchObject({
    complete: true,
    acquiredRecords: 5,
    decoding: "unsupported_format",
    coverage: null,
  });
  const rawOnly = await downloadHistory(memory(), device, { out });
  expect(rawOnly.decoding).toBe("timezone_required");
});
it("handles an empty log without reading nonexistent sectors or records", async () => {
  const result = await downloadHistory(
    memory({
      ...log,
      sectorCount: 0,
      sectors: [],
      recordCount: 0,
      currentAddress: 0,
    }),
    device,
    { out, timezone: "UTC" },
  );
  expect(result).toMatchObject({
    complete: true,
    acquiredRecords: 0,
    csvRows: 0,
    coverage: null,
    decoding: "decoded",
  });
});

it("detects a changed newest record even with unchanged metadata", async () => {
  const reader = memory();
  const original = reader.query.bind(reader);
  reader.query = async (address, words) => {
    const bytes = await original(address, words);
    if (address === log.currentAddress && words === log.entryWords)
      bytes[0] ^= 1;
    return bytes;
  };
  const result = await downloadHistory(reader, device, {
    out,
    timezone: "UTC",
  });
  expect(result.complete).toBe(false);
  expect(result.error).toMatch(/newest log record changed/);
});

it("preserves complete raw data when a record cannot be decoded", async () => {
  const reader = memory();
  const original = reader.query.bind(reader);
  reader.query = async (address, words) => {
    const bytes = await original(address, words);
    if (address === 1000) bytes.writeUInt32LE(0xffffffff);
    return bytes;
  };
  const result = await downloadHistory(reader, device, {
    out,
    timezone: "UTC",
  });
  expect(result).toMatchObject({
    complete: true,
    acquiredRecords: 5,
    decoding: "failed",
  });
  expect(fs.existsSync(path.join(result.directory, "records.jsonl"))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(result.directory, "detailed.csv"))).toBe(
    false,
  );
});
