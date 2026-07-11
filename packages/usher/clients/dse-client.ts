/**
 * DeepSea DSE7410 MkII (GenComm) — Modbus TCP client + full-map decode.
 *
 * Self-contained (depends only on `modbus-serial`) — the device driver for the `musher` source.
 * Lives in the usher package (`@liveone/usher`), the runtime host for device source plugins.
 *
 * GenComm specifics:
 *  - DSE register address = page * 256 + offset. Function 3 (read holding registers).
 *  - 32-bit values span two registers, MOST-SIGNIFICANT-WORD FIRST:
 *      value = (reg[i] << 16) | reg[i+1], then two's-complement if signed, then × scale.
 *  - Sentinels decode to null (n/a): GenComm reserves the TOP 8 CODES of each width
 *      (unsigned 0x…F8–0x…FF; signed the mirror 0x7F…F8–0x7F…FF). On single/split-phase
 *      sets, the unused phases return the full-width sentinel → null.
 *  - Slave/unit id defaults to 10 (DeepSea's default, NOT 1).
 *  - Reads are batched into gap-aware SEGMENTS per page (page 7 interleaves 16-bit
 *    registers among 32-bit accumulators, and has an unsupported hybrid gap); fields are
 *    decoded per-field by (offset, words), never as a contiguous all-32-bit block.
 *
 * READ-ONLY: this module only issues FC3 reads — it never writes to the controller.
 * (The control page — 4104/4105 remote start/stop keys — is deliberately NOT mapped.)
 *
 * Register addresses/scaling beyond Page-4 offsets 0..7 are spec/second-source derived
 * (Victron dbus-modbus-client dse.py + DSE GenComm SP-228) and should be sanity-checked
 * against a live controller before being trusted — see the `confidence`/`note` fields.
 */

import ModbusRTU from "modbus-serial";

export const DEFAULT_HOST = "10.0.1.244";
export const DEFAULT_PORT = 502;
export const DEFAULT_UNIT_ID = 10; // DeepSea default (not 1)
export const DEFAULT_TIMEOUT_MS = 5000; // generous for ~300ms RTT over Teleport

/** Absolute address of the battery-voltage register — the connection sanity anchor. */
export const BATTERY_V_ADDR = 1029;

// ── sentinels ────────────────────────────────────────────────────────────────
// GenComm reserves the TOP 8 CODES of each width as "not available / over-range /
// under-range / transducer fault / bad data / …": unsigned 0x…F8–0x…FF, signed the
// mirror 0x7F…F8–0x7F…FF. Any raw bit pattern in that band decodes to null. (A live
// DSE7410 returned 0x7FFD for an unavailable power factor, so catching only the top
// two codes — 0x…FF/0x…FE — was not enough.)
const U16_SENTINEL_MIN = 0xfff8; // .. 0xffff
const S16_SENTINEL_MIN = 0x7ff8; // .. 0x7fff
const U32_SENTINEL_MIN = 0xfffffff8; // .. 0xffffffff
const S32_SENTINEL_MIN = 0x7ffffff8; // .. 0x7fffffff

// ── interpretation helpers (best-effort enums; raw value is always shown too) ─
// Enum values per DSE GenComm SP-228 (see scripts/modbus-registers.md).
export const CONTROL_MODE: Record<number, string> = {
  0: "Stop",
  1: "Auto",
  2: "Manual",
  3: "Test on load",
  4: "Auto w/ manual restore",
  5: "User configuration",
  6: "Test off load",
  7: "Off",
  65535: "n/a",
};
export const ENGINE_STATE: Record<number, string> = {
  0: "Stopped",
  1: "Pre-start",
  2: "Warming up",
  3: "Running",
  4: "Cooling down",
  5: "Stopped",
  6: "Post-run",
  15: "n/a",
};
export const PHASE_ROTATION: Record<number, string> = {
  0: "None",
  1: "L1-L2-L3",
  2: "L1-L3-L2",
  65535: "n/a",
};
/** DSE named-alarm 4-bit nibble states (each alarm register packs 4 alarms, MSB-first). */
export const ALARM_NIBBLE_STATES: Record<number, string> = {
  0: "disabled",
  1: "not active",
  2: "warning",
  3: "shutdown",
  4: "electrical trip",
};

export type FieldKind = "number" | "enum" | "epoch" | "duration" | "alarmWord";

export interface RegField {
  category: string;
  page: number;
  offset: number; // within the page
  address: number; // absolute = page*256 + offset
  key: string; // camelCase id
  name: string; // human label
  words: 1 | 2; // 1 = 16-bit, 2 = 32-bit
  signed: boolean;
  scale: number; // multiply the combined raw by this
  unit: string;
  confidence: "high" | "medium" | "low";
  kind: FieldKind; // how to interpret for display
  enumMap?: Record<number, string>;
  note?: string;
}

// Compact builder — computes the absolute address from page*256+offset.
function f(
  category: string,
  page: number,
  offset: number,
  key: string,
  name: string,
  words: 1 | 2,
  signed: boolean,
  scale: number,
  unit: string,
  confidence: "high" | "medium" | "low",
  extra: Partial<Pick<RegField, "kind" | "enumMap" | "note">> = {},
): RegField {
  return {
    category,
    page,
    offset,
    address: page * 256 + offset,
    key,
    name,
    words,
    signed,
    scale,
    unit,
    confidence,
    kind: extra.kind ?? "number",
    enumMap: extra.enumMap,
    note: extra.note,
  };
}

const HI = "high" as const;
const MED = "medium" as const;

// Page 154 named-alarm block: register 39424 = count (a live DSE7410 reported 80 named
// alarms → 20 words, 4 alarms packed per register). 39425.. pack 4 alarms/register.
const ALARM_WORDS: RegField[] = Array.from({ length: 20 }, (_, i) =>
  f(
    "Alarms",
    154,
    1 + i,
    `namedAlarm${i + 1}`,
    `Named alarms word ${i + 1}`,
    1,
    false,
    1,
    "",
    i < 9 ? HI : MED,
    { kind: "alarmWord" },
  ),
);

/**
 * The full DSE GenComm register map we read. Ordered by category then address.
 * Page-4 offsets 0..7 are the original live-proven set; everything else is
 * spec/second-source derived (confidence + note flag what to verify).
 */
export const REGISTERS: RegField[] = [
  // ── Engine (basic instrumentation, Page 4 offsets 0..7 — LIVE-PROVEN) ──────
  f("Engine", 4, 0, "oilPressureKpa", "Oil pressure", 1, false, 1, "kPa", HI),
  f(
    "Engine",
    4,
    1,
    "coolantTempC",
    "Coolant temperature",
    1,
    true,
    1,
    "°C",
    HI,
  ),
  f("Engine", 4, 2, "oilTempC", "Oil temperature", 1, true, 1, "°C", HI),
  f("Engine", 4, 3, "fuelLevelPct", "Fuel level", 1, false, 1, "%", HI),
  f("Engine", 4, 4, "chargeAltV", "Charge alt voltage", 1, false, 0.1, "V", HI),
  f("Engine", 4, 5, "batteryV", "Battery voltage", 1, false, 0.1, "V", HI),
  f("Engine", 4, 6, "engineRpm", "Engine speed", 1, false, 1, "rpm", HI),
  f(
    "Engine",
    4,
    7,
    "genFreqHz",
    "Generator frequency",
    1,
    false,
    0.1,
    "Hz",
    HI,
  ),

  // ── Generator AC electrical (Page 4) ──────────────────────────────────────
  f(
    "Generator AC",
    4,
    8,
    "genL1NV",
    "Generator L1-N voltage",
    2,
    false,
    0.1,
    "V",
    HI,
  ),
  f(
    "Generator AC",
    4,
    10,
    "genL2NV",
    "Generator L2-N voltage",
    2,
    false,
    0.1,
    "V",
    HI,
  ),
  f(
    "Generator AC",
    4,
    12,
    "genL3NV",
    "Generator L3-N voltage",
    2,
    false,
    0.1,
    "V",
    HI,
  ),
  f(
    "Generator AC",
    4,
    14,
    "genL1L2V",
    "Generator L1-L2 voltage",
    2,
    false,
    0.1,
    "V",
    MED,
    { note: "L-L block presence to confirm live" },
  ),
  f(
    "Generator AC",
    4,
    16,
    "genL2L3V",
    "Generator L2-L3 voltage",
    2,
    false,
    0.1,
    "V",
    MED,
  ),
  f(
    "Generator AC",
    4,
    18,
    "genL3L1V",
    "Generator L3-L1 voltage",
    2,
    false,
    0.1,
    "V",
    MED,
  ),
  f(
    "Generator AC",
    4,
    20,
    "genL1A",
    "Generator L1 current",
    2,
    false,
    0.1,
    "A",
    HI,
  ),
  f(
    "Generator AC",
    4,
    22,
    "genL2A",
    "Generator L2 current",
    2,
    false,
    0.1,
    "A",
    HI,
  ),
  f(
    "Generator AC",
    4,
    24,
    "genL3A",
    "Generator L3 current",
    2,
    false,
    0.1,
    "A",
    HI,
  ),
  f(
    "Generator AC",
    4,
    26,
    "genEarthA",
    "Generator earth current",
    2,
    false,
    0.1,
    "A",
    MED,
    { note: "confirm sign/scale live" },
  ),
  f(
    "Generator AC",
    4,
    28,
    "genL1W",
    "Generator L1 real power",
    2,
    true,
    1,
    "W",
    HI,
    { note: "scale 1 W assumed; could be 0.1 kW — verify live" },
  ),
  f(
    "Generator AC",
    4,
    30,
    "genL2W",
    "Generator L2 real power",
    2,
    true,
    1,
    "W",
    HI,
  ),
  f(
    "Generator AC",
    4,
    32,
    "genL3W",
    "Generator L3 real power",
    2,
    true,
    1,
    "W",
    HI,
  ),

  // ── Generator power totals & derived (Page 6) ─────────────────────────────
  f(
    "Power",
    6,
    0,
    "genTotalW",
    "Generator total real power",
    2,
    true,
    1,
    "W",
    HI,
    { note: "headline live-generation signal" },
  ),
  f(
    "Power",
    6,
    2,
    "genL1VA",
    "Generator L1 apparent power",
    2,
    false,
    1,
    "VA",
    MED,
  ),
  f(
    "Power",
    6,
    4,
    "genL2VA",
    "Generator L2 apparent power",
    2,
    false,
    1,
    "VA",
    MED,
  ),
  f(
    "Power",
    6,
    6,
    "genL3VA",
    "Generator L3 apparent power",
    2,
    false,
    1,
    "VA",
    MED,
  ),
  f(
    "Power",
    6,
    8,
    "genTotalVA",
    "Generator total apparent power",
    2,
    true,
    1,
    "VA",
    MED,
  ),
  f(
    "Power",
    6,
    10,
    "genL1Var",
    "Generator L1 reactive power",
    2,
    true,
    1,
    "var",
    MED,
  ),
  f(
    "Power",
    6,
    12,
    "genL2Var",
    "Generator L2 reactive power",
    2,
    true,
    1,
    "var",
    MED,
  ),
  f(
    "Power",
    6,
    14,
    "genL3Var",
    "Generator L3 reactive power",
    2,
    true,
    1,
    "var",
    MED,
  ),
  f(
    "Power",
    6,
    16,
    "genTotalVar",
    "Generator total reactive power",
    2,
    true,
    1,
    "var",
    MED,
  ),
  f(
    "Power",
    6,
    18,
    "genPfL1",
    "Generator power factor L1",
    1,
    true,
    0.01,
    "",
    MED,
  ),
  f(
    "Power",
    6,
    19,
    "genPfL2",
    "Generator power factor L2",
    1,
    true,
    0.01,
    "",
    MED,
  ),
  f(
    "Power",
    6,
    20,
    "genPfL3",
    "Generator power factor L3",
    1,
    true,
    0.01,
    "",
    MED,
  ),
  f(
    "Power",
    6,
    21,
    "genAvgPf",
    "Generator average power factor",
    1,
    true,
    0.01,
    "",
    HI,
  ),
  f(
    "Power",
    6,
    22,
    "genLoadPct",
    "Generator load (% of full power)",
    1,
    true,
    0.1,
    "%",
    HI,
  ),
  f(
    "Power",
    6,
    23,
    "genReactiveLoadPct",
    "Generator reactive load (% of full var)",
    1,
    true,
    0.1,
    "%",
    MED,
  ),

  // ── Energy accumulators (Page 7) ──────────────────────────────────────────
  f(
    "Energy",
    7,
    8,
    "genPosKwh",
    "Generator positive kWh (exported)",
    2,
    false,
    0.1,
    "kWh",
    HI,
    { note: "×0.1 resolution to confirm live" },
  ),
  f(
    "Energy",
    7,
    10,
    "genNegKwh",
    "Generator negative kWh (reverse)",
    2,
    false,
    0.1,
    "kWh",
    HI,
  ),
  f("Energy", 7, 12, "genKvah", "Generator kVAh", 2, false, 0.1, "kVAh", HI),
  f("Energy", 7, 14, "genKvarh", "Generator kVArh", 2, false, 0.1, "kvarh", HI),

  // ── Accumulated run stats, fuel & maintenance (Page 7) ────────────────────
  f(
    "Run stats",
    7,
    0,
    "controllerTime",
    "Controller clock",
    2,
    false,
    1,
    "s",
    HI,
    { kind: "epoch" },
  ),
  f(
    "Run stats",
    7,
    2,
    "timeToMaint",
    "Time to next engine maintenance",
    2,
    true,
    1,
    "s",
    HI,
    { kind: "duration", note: "negative = overdue" },
  ),
  f(
    "Run stats",
    7,
    4,
    "timeOfMaint",
    "Time of next engine maintenance",
    2,
    false,
    1,
    "s",
    HI,
    { kind: "epoch" },
  ),
  f(
    "Run stats",
    7,
    6,
    "engineRunTime",
    "Engine run time",
    2,
    false,
    1,
    "s",
    HI,
    { kind: "duration" },
  ),
  f(
    "Run stats",
    7,
    16,
    "numStarts",
    "Number of engine starts",
    2,
    false,
    1,
    "count",
    HI,
  ),
  f("Run stats", 7, 34, "fuelUsed", "Fuel used", 2, false, 1, "L", MED, {
    note: "unit L vs 0.1L to confirm live",
  }),
  // plant-battery run-time/cycles (offsets 88/90) are a hybrid-controller feature — the
  // DSE7410 MkII returns Modbus exception 1 (illegal function) for them, so they're not mapped.
  f(
    "Run stats",
    7,
    100,
    "fuelEfficiency",
    "Fuel efficiency (accumulated)",
    1,
    false,
    0.01,
    "kWh/L",
    MED,
    { note: "lone 16-bit reg on page 7" },
  ),

  // ── Status (Page 3 control/status, Page 5 engine state, Page 4 phase/lag) ──
  f(
    "Status",
    3,
    4,
    "controlMode",
    "Control / operating mode",
    1,
    false,
    1,
    "",
    HI,
    { kind: "enum", enumMap: CONTROL_MODE, note: "enum best-effort" },
  ),
  f(
    "Status",
    3,
    5,
    "controlModeSelection",
    "Control mode selection",
    1,
    false,
    1,
    "",
    MED,
    { kind: "enum", enumMap: CONTROL_MODE },
  ),
  f(
    "Status",
    5,
    128,
    "engineState",
    "Engine operating state",
    1,
    false,
    1,
    "",
    HI,
    { kind: "enum", enumMap: ENGINE_STATE, note: "enum best-effort" },
  ),
  f(
    "Status",
    4,
    48,
    "mainsVLagLead",
    "Mains voltage phase lag/lead (vs gen)",
    1,
    true,
    1,
    "°",
    MED,
  ),
  f(
    "Status",
    4,
    49,
    "genPhaseRotation",
    "Generator phase rotation",
    1,
    false,
    1,
    "",
    MED,
    { kind: "enum", enumMap: PHASE_ROTATION },
  ),
  f(
    "Status",
    4,
    50,
    "mainsPhaseRotation",
    "Mains phase rotation",
    1,
    false,
    1,
    "",
    MED,
    { kind: "enum", enumMap: PHASE_ROTATION },
  ),

  // ── Identity / metadata (read once — Page 0 + Page 3) ─────────────────────
  f("Identity", 0, 9, "gencommVersion", "GenComm version", 1, false, 1, "", HI),
  f(
    "Identity",
    3,
    0,
    "manufacturerCode",
    "Manufacturer code",
    1,
    false,
    1,
    "",
    HI,
  ),
  f("Identity", 3, 1, "modelNumber", "Model number", 1, false, 1, "", HI),
  f("Identity", 3, 2, "serialNumber", "Serial number", 2, false, 1, "", HI),

  // ── Named alarms (Page 154) ───────────────────────────────────────────────
  f(
    "Alarms",
    154,
    0,
    "namedAlarmCount",
    "Named alarm count",
    1,
    false,
    1,
    "",
    HI,
  ),
  ...ALARM_WORDS,

  // ── Mains / utility — CONDITIONAL: expect n/a on a plain DSE7410 MkII ──────
  // (auto-start-only; no mains monitoring / no mains CTs. The 7420 is the AMF variant.)
  f(
    "Mains (conditional)",
    4,
    35,
    "mainsFreqHz",
    "Mains frequency",
    1,
    false,
    0.1,
    "Hz",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    36,
    "mainsL1NV",
    "Mains L1-N voltage",
    2,
    false,
    0.1,
    "V",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    38,
    "mainsL2NV",
    "Mains L2-N voltage",
    2,
    false,
    0.1,
    "V",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    40,
    "mainsL3NV",
    "Mains L3-N voltage",
    2,
    false,
    0.1,
    "V",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    42,
    "mainsL1L2V",
    "Mains L1-L2 voltage",
    2,
    false,
    0.1,
    "V",
    MED,
  ),
  f(
    "Mains (conditional)",
    4,
    44,
    "mainsL2L3V",
    "Mains L2-L3 voltage",
    2,
    false,
    0.1,
    "V",
    MED,
  ),
  f(
    "Mains (conditional)",
    4,
    46,
    "mainsL3L1V",
    "Mains L3-L1 voltage",
    2,
    false,
    0.1,
    "V",
    MED,
  ),
  f(
    "Mains (conditional)",
    4,
    52,
    "mainsL1A",
    "Mains L1 current",
    2,
    false,
    0.1,
    "A",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    54,
    "mainsL2A",
    "Mains L2 current",
    2,
    false,
    0.1,
    "A",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    56,
    "mainsL3A",
    "Mains L3 current",
    2,
    false,
    0.1,
    "A",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    60,
    "mainsL1W",
    "Mains L1 real power",
    2,
    true,
    1,
    "W",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    62,
    "mainsL2W",
    "Mains L2 real power",
    2,
    true,
    1,
    "W",
    HI,
  ),
  f(
    "Mains (conditional)",
    4,
    64,
    "mainsL3W",
    "Mains L3 real power",
    2,
    true,
    1,
    "W",
    HI,
  ),
  f(
    "Mains (conditional)",
    6,
    24,
    "mainsTotalW",
    "Mains total real power",
    2,
    true,
    1,
    "W",
    MED,
  ),
  f(
    "Mains (conditional)",
    7,
    18,
    "mainsPosKwh",
    "Mains positive kWh (import)",
    2,
    false,
    0.1,
    "kWh",
    MED,
  ),
  f(
    "Mains (conditional)",
    7,
    20,
    "mainsNegKwh",
    "Mains negative kWh (export)",
    2,
    false,
    0.1,
    "kWh",
    MED,
  ),
];

// ── decode primitives ───────────────────────────────────────────────────────

/** Combine 1 or 2 raw 16-bit words (MSW-first) into an unsigned integer. */
function rawUnsigned(words: number[]): number {
  return words.length === 2 ? words[0] * 65536 + words[1] : words[0];
}

/** True if the raw bit pattern is in this field's GenComm sentinel band (→ n/a). */
function isSentinel(field: RegField, words: number[]): boolean {
  const u = rawUnsigned(words);
  if (field.words === 2) {
    return field.signed
      ? u >= S32_SENTINEL_MIN && u <= 0x7fffffff
      : u >= U32_SENTINEL_MIN;
  }
  return field.signed
    ? u >= S16_SENTINEL_MIN && u <= 0x7fff
    : u >= U16_SENTINEL_MIN;
}

/** Apply two's-complement (if signed) and scaling; assumes not a sentinel. */
function toEngineering(field: RegField, words: number[]): number {
  let v = rawUnsigned(words);
  if (field.signed) {
    const top = field.words === 2 ? 0x80000000 : 0x8000;
    const wrap = field.words === 2 ? 0x100000000 : 0x10000;
    if (v >= top) v -= wrap;
  }
  return v * field.scale;
}

/** Decode a field's raw words into an engineering value, or null if n/a. */
export function decodeField(field: RegField, words: number[]): number | null {
  if (words.length < field.words) return null;
  if (isSentinel(field, words)) return null;
  return toEngineering(field, words);
}

export interface FieldReading {
  field: RegField;
  rawWords: number[]; // 1 or 2 raw registers ([] on read error)
  rawInt: number | null; // combined unsigned raw (null on read error)
  value: number | null; // decoded engineering value (null = n/a sentinel or error)
  error?: string;
}

export interface DumpResult {
  unitId: number;
  readings: FieldReading[];
  pageErrors: { page: number; base: number; count: number; error: string }[];
}

export interface DseClientOptions {
  host?: string;
  port?: number;
  unitId?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/** Thin wrapper over modbus-serial for reading DSE GenComm pages over TCP. */
export class DseClient {
  readonly host: string;
  readonly port: number;
  unitId: number;
  readonly timeoutMs: number;
  private readonly log: (msg: string) => void;
  private readonly client = new ModbusRTU();
  private connected = false;

  constructor(opts: DseClientOptions = {}) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.unitId = opts.unitId ?? DEFAULT_UNIT_ID;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? (() => {});
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.log(`TCP connect ${this.host}:${this.port} …`);
    // modbus-serial's setTimeout only bounds Modbus request time, not the initial
    // TCP handshake — race a manual timeout so a down VPN fails fast with a hint.
    await withTimeout(
      this.client.connectTCP(this.host, { port: this.port }),
      this.timeoutMs,
      `TCP connect to ${this.host}:${this.port} timed out after ${this.timeoutMs}ms — is the Teleport VPN up?`,
    );
    this.client.setTimeout(this.timeoutMs);
    this.connected = true;
  }

  /** Point the client at a different Modbus slave/unit id (e.g. fallback 10 → 1). */
  setUnitId(unitId: number): void {
    this.unitId = unitId;
  }

  /** Read the battery voltage (reg 1029) — the lightweight connection sanity probe. */
  async probeBatteryV(): Promise<number | null> {
    if (!this.connected) await this.connect();
    this.client.setID(this.unitId);
    const res = await this.client.readHoldingRegisters(BATTERY_V_ADDR, 1);
    const battery = REGISTERS.find((r) => r.address === BATTERY_V_ADDR)!;
    return decodeField(battery, res.data);
  }

  /**
   * Read every mapped register. Within a page, fields are grouped into contiguous-ish
   * SEGMENTS (merging across gaps up to MAX_GAP registers, capped at the FC3 125-register
   * limit) and each segment is read as one FC3 request. This batches the common case yet
   * keeps an unsupported register (e.g. page 7's hybrid plant-battery gap, which returns
   * "illegal function") from failing a whole page. On a segment-level failure we fall back
   * to reading its fields individually. Fields are decoded by (offset, words), which
   * correctly handles page 7's 16-bit registers interleaved among 32-bit accumulators.
   */
  async readAll(): Promise<DumpResult> {
    if (!this.connected) await this.connect();
    this.client.setID(this.unitId);

    const MAX_GAP = 16; // merge fields into one read across gaps up to this many registers
    const MAX_SPAN = 125; // FC3 hard limit

    const byPage = new Map<number, RegField[]>();
    for (const fld of REGISTERS) {
      const arr = byPage.get(fld.page) ?? [];
      arr.push(fld);
      byPage.set(fld.page, arr);
    }

    const readings: FieldReading[] = [];
    const pageErrors: DumpResult["pageErrors"] = [];

    for (const [page, allFields] of [...byPage.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const fields = allFields.sort((a, b) => a.offset - b.offset);

      // Build segments: greedily extend while the next field is within MAX_GAP and the
      // span stays under the FC3 limit.
      const segments: RegField[][] = [];
      let cur: RegField[] = [];
      let segStart = 0;
      let segEnd = 0; // exclusive
      for (const fld of fields) {
        const end = fld.offset + fld.words;
        if (cur.length === 0) {
          cur = [fld];
          segStart = fld.offset;
          segEnd = end;
        } else if (
          fld.offset - segEnd <= MAX_GAP &&
          end - segStart <= MAX_SPAN
        ) {
          cur.push(fld);
          segEnd = Math.max(segEnd, end);
        } else {
          segments.push(cur);
          cur = [fld];
          segStart = fld.offset;
          segEnd = end;
        }
      }
      if (cur.length) segments.push(cur);

      for (const seg of segments) {
        const start = seg[0].offset;
        const base = page * 256 + start;
        const count = Math.max(...seg.map((r) => r.offset + r.words)) - start;

        let raw: number[] | null = null;
        try {
          const res = await this.client.readHoldingRegisters(base, count);
          raw = res.data;
        } catch (err) {
          pageErrors.push({
            page,
            base,
            count,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        for (const fld of seg) {
          if (raw) {
            const i = fld.offset - start;
            const words = raw.slice(i, i + fld.words);
            readings.push({
              field: fld,
              rawWords: words,
              rawInt: rawUnsigned(words),
              value: decodeField(fld, words),
            });
          } else {
            // per-field fallback for this segment
            try {
              const res = await this.client.readHoldingRegisters(
                fld.address,
                fld.words,
              );
              readings.push({
                field: fld,
                rawWords: res.data,
                rawInt: rawUnsigned(res.data),
                value: decodeField(fld, res.data),
              });
            } catch (err) {
              readings.push({
                field: fld,
                rawWords: [],
                rawInt: null,
                value: null,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    }

    return { unitId: this.unitId, readings, pageErrors };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await new Promise<void>((resolve) => this.client.close(() => resolve()));
    this.connected = false;
  }
}

/** Reject with `message` if `promise` hasn't settled within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timer),
  ) as Promise<T>;
}
