import { describe, it, expect } from "@jest/globals";
import {
  acquireEventLog,
  decodeEventRecord,
  EVENT_LOGS,
  EVENT_RECORD_WORDS,
  eventLogMetadata,
  eventRecordId,
  CLOCK_ADDRESS,
  readDeviceClock,
  readScales,
  SCALES_ADDRESS,
  supportedEventFormat,
  toEventRecord,
  type EventLog,
  type EventScales,
} from "../events";
import { label, labelProvenance } from "../event-labels";
import type { MemoryReader } from "../protocol";
import fixtures from "./fixtures/event-records.json";

const scales = (): EventScales => ({
  acVoltage: 5300,
  acCurrent: 2200,
  dcVoltage: 1050,
  dcCurrent: 12000,
  temperature: 530,
  reserved: 180,
});
const fixture = (log: EventLog, code: number) => {
  const found = fixtures.records.find(
    (r) => r.log === log && Buffer.from(r.hex, "hex").readUInt16LE(4) === code,
  );
  if (!found) throw new Error(`No fixture for ${log} ${code}`);
  return toEventRecord(log, found.address, found.hex);
};
const decode = (log: EventLog, code: number) =>
  decodeEventRecord(fixture(log, code), scales());

describe("event labels", () => {
  it("carries its provenance", () => {
    expect(labelProvenance.vendorSoftware).toBe("SP LINK 16.11.9663");
    expect(labelProvenance.assemblySha256).toHaveLength(64);
  });
  it("names the codes the September 2026 incidents turned on", () => {
    expect(label("alertEvent", 50)).toBe("Unit - Instant Low DC Voltage Fault");
    expect(label("alertEvent", 127)).toBe(
      "System - Main DC Supply Cable Open Circuit Fault",
    );
    expect(label("alertEvent", 128)).toBe(
      "System - Main DC Supply Cable Open Circuit Fault Cleared",
    );
    expect(label("operationalEvent", 141)).toBe(
      "Shunts - Shunt 1 Input limit fault",
    );
    expect(label("generatorReason", 5)).toBe("Impending Inverter Shutdown");
  });
  it("reports an unknown code rather than guessing, and keeps a blank label blank", () => {
    expect(label("alertEvent", 64000)).toBe("UNDECODED(64000)");
    expect(label("alertEvent", 0)).toBe("");
  });
});

describe("decodeEventRecord", () => {
  it("reproduces the 17 September low-DC alert", () => {
    const e = decode("alert", 50);
    expect(e.device_time).toBe("2026-09-17T19:51:33");
    expect(e.description).toBe("Unit - Instant Low DC Voltage Fault");
    expect(e.code_known).toBe(true);
    expect(e.dc_voltage_v).toBeCloseTo(51.69, 2);
    expect(e.load_ac_power_kw).toBeCloseTo(7.181, 2);
    expect(e.snapshot_suspect).toBe(false);
  });

  it("reproduces the DC-supply open-circuit fault and its clearance as SEPARATE records", () => {
    const fault = decode("alert", 127);
    const cleared = decode("alert", 128);
    expect(fault.device_time).toBe("2026-09-17T20:55:39");
    expect(cleared.device_time).toBe("2026-09-17T20:57:30");
    // The inverter records a fault and its clearance as two events. Nothing here pairs them; the
    // portal is the source that supplies a Created/Cleared pair, and its clock is not this one.
    expect(fault.id).not.toBe(cleared.id);
  });

  it("decodes the generator start reason that explains the takeover", () => {
    const e = decode("operational", 149);
    expect(e.generator_start_reason).toBe("Impending Inverter Shutdown");
    expect(e.generator_start_reason_code).toBe(5);
  });

  it("decodes contactor state at the moment the generator took the load", () => {
    const e = decode("operational", 148);
    expect(e.device_time).toBe("2026-09-17T19:51:50");
    expect(e.contactor_state).toBe("AcSourceClosed-InverterOpened");
  });

  it("keeps every raw word, so an unmapped field is preserved rather than lost", () => {
    const e = decode("operational", 142);
    expect(e.raw_words).toHaveLength(EVENT_RECORD_WORDS);
    expect(e.raw_hex).toHaveLength(EVENT_RECORD_WORDS * 4);
    expect(e.description).toBe("Shunts - Shunt 1 Input limit fault cleared");
  });

  it("prefers the record's own scale tail over the device-wide block", () => {
    const record = fixture("alert", 50);
    const wrong = { ...scales(), acCurrent: 1, dcCurrent: 1 };
    const e = decodeEventRecord(record, wrong);
    // w[32] and w[34] carry the AC/DC current scales, so the deliberately wrong block is ignored.
    expect(e.scale_ac_current).toBe(2200);
    expect(e.scale_dc_current).toBe(12000);
    expect(e.dc_voltage_v).toBeCloseTo(51.69, 2);
  });

  it("rejects a record of the wrong length instead of decoding garbage", () => {
    const record = toEventRecord("alert", 0, "00".repeat(40));
    expect(() => decodeEventRecord(record, scales())).toThrow(
      /Unsupported event record length/,
    );
  });
});

describe("eventRecordId", () => {
  it("is the record's bytes, not its address — the ring reuses addresses", () => {
    const a = fixture("alert", 50);
    const moved = { ...a, address: a.address + 36 * 1000 };
    expect(eventRecordId("alert", moved.deviceSeconds, moved.hex)).toBe(
      eventRecordId("alert", a.deviceSeconds, a.hex),
    );
  });
  it("separates the same code in the two logs", () => {
    const a = fixture("alert", 50);
    expect(eventRecordId("alert", a.deviceSeconds, a.hex)).not.toBe(
      eventRecordId("operational", a.deviceSeconds, a.hex),
    );
  });
});

describe("supportedEventFormat", () => {
  it("accepts only the validated layout", () => {
    expect(supportedEventFormat(3, 36)).toBe(true);
    expect(supportedEventFormat(2, 36)).toBe(false);
    expect(supportedEventFormat(3, 44)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A simulated inverter: one sector, fixed-size records, newest at `current`.
// ---------------------------------------------------------------------------
const START = 10000;
function simulatedLog(records: string[], log: EventLog = "alert") {
  const base = EVENT_LOGS[log];
  const words = new Map<number, number>();
  const put = (address: number, hex: string) => {
    const bytes = Buffer.from(hex, "hex");
    for (let i = 0; i < bytes.length / 2; i++)
      words.set(address + i, bytes.readUInt16LE(i * 2));
  };
  // Oldest first in memory; `current` points at the newest.
  records.forEach((hex, i) => put(START + i * EVENT_RECORD_WORDS, hex));
  const current = START + (records.length - 1) * EVENT_RECORD_WORDS;
  const end = START + 64 * EVENT_RECORD_WORDS - 1;
  const header = Buffer.alloc(10);
  header.writeUInt16LE(1, 0);
  header.writeUInt16LE(EVENT_RECORD_WORDS, 2);
  header.writeUInt32LE(current, 4);
  header.writeUInt16LE(records.length, 8);
  const sectors = Buffer.alloc(8);
  sectors.writeUInt32LE(START, 0);
  sectors.writeUInt32LE(end, 4);
  const reads: { address: number; words: number }[] = [];
  const reader: MemoryReader = {
    async query(address, count) {
      reads.push({ address, words: count });
      if (address === base) return header.subarray(0, count * 2);
      if (address === base + 5) return sectors.subarray(0, count * 2);
      const out = Buffer.alloc(count * 2);
      for (let i = 0; i < count; i++)
        out.writeUInt16LE(words.get(address + i) ?? 0, i * 2);
      return out;
    },
  };
  return { reader, reads, put, current };
}
const synthetic = (seconds: number, code: number) => {
  const b = Buffer.alloc(EVENT_RECORD_WORDS * 2);
  b.writeUInt32LE(seconds, 0);
  b.writeUInt16LE(code, 4);
  b.writeUInt16LE(2200, 64);
  b.writeUInt16LE(12000, 68);
  return b.toString("hex");
};

describe("acquireEventLog", () => {
  const rows = [
    synthetic(1000, 10),
    synthetic(2000, 11),
    synthetic(3000, 12),
    synthetic(4000, 13),
  ];

  it("reads newest-first and verifies both anchors", async () => {
    const { reader } = simulatedLog(rows);
    const result = await acquireEventLog(reader, "alert");
    expect(result.records.map((r) => r.deviceSeconds)).toEqual([
      4000, 3000, 2000, 1000,
    ]);
    expect(result.complete).toBe(true);
    expect(result.metadataStable).toBe(true);
    expect(result.newestAnchorStable).toBe(true);
    expect(result.oldestAnchorStable).toBe(true);
    expect(result.stoppedBecause).toBe("exhausted");
  });

  it("reports no overlap verdict at all on a full read", async () => {
    const { reader } = simulatedLog(rows);
    const result = await acquireEventLog(reader, "alert");
    expect(result.overlapVerdict).toBe("not-incremental");
  });

  it("stops at the previous capture's anchor and INCLUDES it as proof of overlap", async () => {
    const { reader } = simulatedLog(rows);
    const since = {
      deviceSeconds: 2000,
      id: eventRecordId("alert", 2000, rows[1]),
    };
    const result = await acquireEventLog(reader, "alert", { since });
    expect(result.records.map((r) => r.deviceSeconds)).toEqual([
      4000, 3000, 2000,
    ]);
    expect(result.overlapObserved).toBe(true);
    expect(result.overlapVerdict).toBe("confirmed");
    expect(result.stoppedBecause).toBe("overlap");
    expect(result.complete).toBe(true);
  });

  it("reports a GAP only when the whole ring was walked without finding the anchor", async () => {
    const { reader } = simulatedLog(rows);
    const result = await acquireEventLog(reader, "alert", {
      since: { deviceSeconds: 5, id: "i:alert:5:deadbeefdeadbeef" },
    });
    expect(result.incremental).toBe(true);
    expect(result.overlapObserved).toBe(false);
    expect(result.stoppedBecause).toBe("exhausted");
    expect(result.overlapVerdict).toBe("lost");
    expect(result.records).toHaveLength(4);
  });

  it("🛑 does NOT call it a gap when the walk was cut short before reaching the anchor", async () => {
    // A deadline or an abort says nothing about whether those records still exist. Reporting it as
    // loss announces permanent data loss on no evidence — and a bounded 40-second acquisition
    // produces exactly this outcome when a site is in trouble, which is when it matters most.
    const { reader } = simulatedLog(rows);
    const controller = new AbortController();
    controller.abort();
    const result = await acquireEventLog(reader, "alert", {
      since: { deviceSeconds: 5, id: "i:alert:5:deadbeefdeadbeef" },
      signal: controller.signal,
    });
    expect(result.stoppedBecause).toBe("aborted");
    expect(result.overlapObserved).toBe(false);
    expect(result.overlapVerdict).toBe("unverified");
    expect(result.complete).toBe(false);
  });

  it("an EMPTY ring we were asked to resume into is a real gap", async () => {
    const { reader } = simulatedLog([]);
    const result = await acquireEventLog(reader, "alert", {
      since: { deviceSeconds: 5, id: "i:alert:5:deadbeefdeadbeef" },
    });
    expect(result.overlapVerdict).toBe("lost");
  });

  it("stops one record past a device-time boundary", async () => {
    const { reader } = simulatedLog(rows);
    const result = await acquireEventLog(reader, "alert", {
      sinceDeviceTime: toEventRecord("alert", 0, rows[2]).deviceTime,
    });
    expect(result.records.map((r) => r.deviceSeconds)).toEqual([
      4000, 3000, 2000,
    ]);
    expect(result.stoppedBecause).toBe("since-device-time");
  });

  it("marks a capture incomplete when the newest record changed underneath it", async () => {
    const { reader, put } = simulatedLog(rows);
    let first = true;
    const wrapped: MemoryReader = {
      async query(address, count) {
        const bytes = await reader.query(address, count);
        if (first && address === START + 3 * EVENT_RECORD_WORDS) {
          first = false;
          put(START + 3 * EVENT_RECORD_WORDS, synthetic(9999, 99));
        }
        return bytes;
      },
    };
    const result = await acquireEventLog(wrapped, "alert");
    expect(result.newestAnchorStable).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("abandons the walk on abort, keeping what it read", async () => {
    const { reader } = simulatedLog(rows);
    const controller = new AbortController();
    controller.abort();
    const result = await acquireEventLog(reader, "alert", {
      signal: controller.signal,
    });
    expect(result.stoppedBecause).toBe("aborted");
    expect(result.records).toHaveLength(0);
    expect(result.complete).toBe(false);
  });

  it("handles an empty log without inventing records", async () => {
    const { reader } = simulatedLog([]);
    const result = await acquireEventLog(reader, "alert");
    expect(result.records).toHaveLength(0);
    expect(result.complete).toBe(true);
  });

  it("refuses an unexpected record size rather than misreading the ring", async () => {
    // One record, so `current` is the sector start and the descriptor stays ALIGNED for any record
    // size — the size itself is then the only thing wrong with it.
    const { reader } = simulatedLog([rows[0]]);
    const wrapped: MemoryReader = {
      async query(address, count) {
        const bytes = await reader.query(address, count);
        if (address === EVENT_LOGS.alert) bytes.writeUInt16LE(44, 2);
        return bytes;
      },
    };
    await expect(acquireEventLog(wrapped, "alert")).rejects.toThrow(
      /44-word records/,
    );
  });

  it("reads the operational log from its own descriptor", async () => {
    const { reader, reads } = simulatedLog(rows, "operational");
    await eventLogMetadata(reader, "operational");
    expect(reads[0].address).toBe(EVENT_LOGS.operational);
    expect(EVENT_LOGS.operational).not.toBe(EVENT_LOGS.alert);
  });
});

describe("readScales / readDeviceClock", () => {
  const block = Buffer.from(fixtures.scales.hex, "hex");
  const clock = Buffer.from(fixtures.clock.hex, "hex");
  const reader: MemoryReader = {
    async query(address, count) {
      if (address === SCALES_ADDRESS) return block.subarray(0, count * 2);
      if (address === CLOCK_ADDRESS) return clock.subarray(0, count * 2);
      throw new Error(`unexpected read at ${address}`);
    },
  };

  it("reads the installation's own scaling factors", async () => {
    await expect(readScales(reader)).resolves.toEqual({
      acVoltage: 5300,
      acCurrent: 2200,
      dcVoltage: 1050,
      dcCurrent: 12000,
      temperature: 530,
      reserved: 180,
    });
  });

  it("refuses an empty scaling block rather than converting with zeros", async () => {
    const empty: MemoryReader = {
      query: async (_address, count) => Buffer.alloc(count * 2),
    };
    await expect(readScales(empty)).rejects.toThrow(/scaling block/);
  });

  it("decodes the BCD clock and measures the offset against our own", async () => {
    const result = await readDeviceClock(reader, "Australia/Melbourne");
    expect(result.deviceTime).toBe("2026-09-18T15:32:53");
    expect(result.offsetSeconds).not.toBeNull();
  });

  it("yields no offset without a timezone, rather than assuming UTC", async () => {
    const result = await readDeviceClock(reader);
    expect(result.offsetSeconds).toBeNull();
    expect(result.deviceTime).toBe("2026-09-18T15:32:53");
  });
});
