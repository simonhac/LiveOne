#!/usr/bin/env tsx
/**
 * DeepSea DSE7410 MkII (GenComm) Modbus TCP reader — CLI.
 *
 * Connects to the DSE over the Teleport tunnel, reads the FULL mapped GenComm register
 * set (engine, generator AC, power, energy, run-stats, status, identity, alarms, and the
 * conditional mains block), decodes/interprets each, and prints them grouped by category.
 * Sanity-anchors on battery voltage (always populated on a 12V/24V system) to prove the
 * connection + register math.
 *
 * Run (the Teleport VPN must be up):
 *   npm run deepsea:poll
 *   npm run deepsea:poll -- --raw                 # also show raw register words
 *   npm run deepsea:poll -- --count=3 --interval=5
 *   npm run deepsea:poll -- --host=10.0.1.244 --unit=10
 *   npm run deepsea:poll -- --help
 *
 * Connection defaults come from .env.local (DEEPSEA_HOST / DEEPSEA_PORT / DEEPSEA_UNIT_ID)
 * and can be overridden by flags. The DSE IP is DHCP-assigned — reserve .244 to its MAC
 * (e8:a4:c1:06:47:03) in UniFi, or pass --host.
 *
 * READ-ONLY: only issues FC3 (read holding registers). Writes nothing to the controller.
 *
 * NOTE: everything beyond Page-4 offsets 0..7 is spec/second-source derived — treat medium/
 * low-confidence rows (and the scale/unit `note`s in dse-client.ts) as unverified until
 * eyeballed against the live genset in both stopped and running states.
 */

import {
  DseClient,
  REGISTERS,
  ALARM_NIBBLE_STATES,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_UNIT_ID,
  type DumpResult,
  type FieldReading,
} from "../clients/dse-client";

// ── arg parsing ─────────────────────────────────────────────────────────────
type Args = {
  count: number;
  intervalSec: number;
  host?: string;
  port?: number;
  unit?: number;
  raw: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    flags.set(m[1], m[2] ?? true);
  }
  const num = (k: string, dflt: number) => {
    const v = flags.get(k);
    if (v == null || v === true) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const str = (k: string) => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const countGiven = flags.has("count");
  return {
    count: countGiven ? Math.max(1, Math.floor(num("count", 1))) : 1,
    intervalSec: Math.max(1, Math.floor(num("interval", 5))),
    host: str("host"),
    port: flags.has("port") ? num("port", DEFAULT_PORT) : undefined,
    unit: flags.has("unit") ? num("unit", DEFAULT_UNIT_ID) : undefined,
    raw: flags.has("raw"),
    help: flags.has("help"),
  };
}

const HELP = `DeepSea DSE7410 MkII (GenComm) Modbus TCP reader — CLI

Usage: npm run deepsea:poll -- [flags]

  --count=N              read the full map N times (default 1)
  --interval=SECONDS     seconds between reads (default 5)
  --host=IP              controller IP (default env DEEPSEA_HOST or ${DEFAULT_HOST})
  --port=N               Modbus TCP port (default env DEEPSEA_PORT or ${DEFAULT_PORT})
  --unit=N               Modbus slave/unit id (default env DEEPSEA_UNIT_ID or ${DEFAULT_UNIT_ID})
  --raw                  also print each register's raw word(s)
  --help                 show this help

Requires the Teleport VPN to be up (the DSE is LAN-only). READ-ONLY — writes nothing.`;

// ── formatting helpers ──────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

function fmtEpoch(sec: number): string {
  return `${new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function fmtDuration(sec: number): string {
  const neg = sec < 0;
  const a = Math.abs(sec);
  const base = a >= 3600 ? `${(a / 3600).toFixed(1)} h` : `${a} s`;
  return neg ? `OVERDUE by ${base}` : base;
}

function fmtAlarmWord(raw: number): string {
  const hex = `0x${raw.toString(16).padStart(4, "0")}`;
  if (raw === 0) return `${hex} (all clear)`;
  const nibbles = [
    (raw >> 12) & 0xf,
    (raw >> 8) & 0xf,
    (raw >> 4) & 0xf,
    raw & 0xf,
  ];
  const active = nibbles
    .map((n, idx) => ({ n, idx }))
    .filter((x) => x.n >= 2 && x.n !== 15) // 0=disabled, 1=not active, 15=unimplemented
    .map((x) => `n${x.idx}:${ALARM_NIBBLE_STATES[x.n] ?? `state ${x.n}`}`);
  return active.length
    ? `${hex} (${active.join(", ")})`
    : `${hex} (none active)`;
}

/** Interpret one reading into a display string, per its field kind. */
function interpret(r: FieldReading): string {
  if (r.error) return `read error (${r.error})`;
  const { field, value, rawInt } = r;
  switch (field.kind) {
    case "enum": {
      if (rawInt == null) return "—";
      if (value == null) return "n/a"; // sentinel (e.g. 0xFFFF = unimplemented on this module)
      const label = field.enumMap?.[rawInt];
      return label ? `${rawInt} (${label})` : `${rawInt} (?)`;
    }
    case "alarmWord":
      return rawInt == null ? "—" : fmtAlarmWord(rawInt);
    case "epoch":
      return value == null ? "n/a" : fmtEpoch(value);
    case "duration":
      return value == null ? "n/a" : fmtDuration(value);
    case "number":
    default:
      return value == null
        ? "n/a"
        : field.unit
          ? `${fmtNumber(value)} ${field.unit}`
          : fmtNumber(value);
  }
}

const CONF_TAG: Record<string, string> = { high: "", medium: " ~", low: " ~~" };

// Category print order (defined categories first, anything else after).
const CATEGORY_ORDER = [
  "Engine",
  "Generator AC",
  "Power",
  "Energy",
  "Run stats",
  "Status",
  "Identity",
  "Alarms",
  "Mains (conditional)",
];

function orderedCategories(): string[] {
  const present = [...new Set(REGISTERS.map((r) => r.category))];
  const known = CATEGORY_ORDER.filter((c) => present.includes(c));
  const extra = present.filter((c) => !CATEGORY_ORDER.includes(c));
  return [...known, ...extra];
}

function printDump(result: DumpResult, raw: boolean): void {
  for (const cat of orderedCategories()) {
    const rows = result.readings.filter((r) => r.field.category === cat);
    if (!rows.length) continue;
    console.log(`\n  ── ${cat} ──`);
    for (const r of rows) {
      const tag = CONF_TAG[r.field.confidence] ?? "";
      let line = `    [${String(r.field.address).padStart(5)}] ${r.field.name.padEnd(34)} ${interpret(r)}${tag}`;
      if (raw && r.rawWords.length) line += `   raw=[${r.rawWords.join(", ")}]`;
      console.log(line);
    }
  }
  if (result.pageErrors.length) {
    console.log("\n  ⚠️  page read errors (fell back to per-field reads):");
    for (const e of result.pageErrors) {
      console.log(
        `     page ${e.page} (base ${e.base}, count ${e.count}): ${e.error}`,
      );
    }
  }
}

/** One-line summary for the polling loop (reads 2..N). */
function fmtCompact(result: DumpResult): string {
  const v = (k: string) =>
    result.readings.find((r) => r.field.key === k)?.value ?? null;
  const s = (k: string, unit: string, dp = 1) => {
    const x = v(k);
    return x == null ? "—" : `${x.toFixed(dp)}${unit}`;
  };
  return `Batt ${s("batteryV", "V")}  Engine ${s("engineRpm", "rpm", 0)}  Freq ${s("genFreqHz", "Hz")}  GenPwr ${s("genTotalW", "W", 0)}  Load ${s("genLoadPct", "%")}`;
}

// Battery voltage should always read on a 12V or 24V system — this is the anchor
// that proves the connection + register math. Allow charging headroom on both.
const BATTERY_MIN_V = 8;
const BATTERY_MAX_V = 32;

function printVerdict(batteryV: number | null, okReads: number): void {
  console.log("\n" + "─".repeat(72));
  if (
    batteryV != null &&
    batteryV >= BATTERY_MIN_V &&
    batteryV <= BATTERY_MAX_V
  ) {
    console.log(
      `✅ VERDICT: battery voltage ${fmtNumber(batteryV)} V is sensible (12V or 24V system), ` +
        `${okReads} read(s) OK → connection + register math proven.`,
    );
  } else if (batteryV == null) {
    console.log(
      "⚠️  VERDICT: battery voltage read n/a — unexpected (reg 1029 should always be populated). " +
        "Check the unit id / that Modbus TCP is enabled on the controller.",
    );
  } else {
    console.log(
      `⚠️  VERDICT: battery voltage ${fmtNumber(batteryV)} V is outside the expected ` +
        `${BATTERY_MIN_V}–${BATTERY_MAX_V} V range — re-check register scaling / unit id.`,
    );
  }
  console.log(
    "Legend: '~' = medium confidence, '~~' = low (spec/second-source derived, verify live). " +
      "'n/a' = sensor sentinel. Mains block is expected n/a on a plain DSE7410 MkII.",
  );
  console.log("─".repeat(72));
}

/** Probe the configured unit id, falling back to 1 (DSE default is 10). Returns working unit. */
async function resolveUnit(
  client: DseClient,
  primaryUnit: number,
): Promise<number> {
  try {
    await client.probeBatteryV();
    return primaryUnit;
  } catch (err) {
    if (primaryUnit === 1) throw err;
    console.log(
      `   unit ${primaryUnit} did not answer (${err instanceof Error ? err.message : String(err)}); retrying unit 1 …`,
    );
    client.setUnitId(1);
    await client.probeBatteryV();
    return 1;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const host = args.host ?? process.env.DEEPSEA_HOST ?? DEFAULT_HOST;
  const port =
    args.port ??
    (process.env.DEEPSEA_PORT
      ? Number(process.env.DEEPSEA_PORT)
      : DEFAULT_PORT);
  const unitId =
    args.unit ??
    (process.env.DEEPSEA_UNIT_ID
      ? Number(process.env.DEEPSEA_UNIT_ID)
      : DEFAULT_UNIT_ID);

  console.log("═".repeat(72));
  console.log("  DeepSea DSE7410 MkII (GenComm) — Modbus TCP full-map reader");
  console.log("═".repeat(72));
  console.log(`  Target  : ${host}:${port}  (unit id ${unitId})`);
  console.log(
    `  Mapped  : ${REGISTERS.length} registers across pages 0, 3, 4, 5, 6, 7, 154`,
  );
  console.log(
    `  Plan    : ${args.count > 1 ? `${args.count} reads @ ${args.intervalSec}s` : "single snapshot"}`,
  );

  const client = new DseClient({
    host,
    port,
    unitId,
    log: (m) => console.log(`  ${m}`),
  });

  let okReads = 0;
  let lastBatteryV: number | null = null;

  try {
    // ① Connect + resolve unit id ---------------------------------------------
    console.log("\n① Connecting …");
    await client.connect();
    const workingUnit = await resolveUnit(client, unitId);
    if (workingUnit !== unitId)
      console.log(`   (answered on unit id ${workingUnit})`);
    console.log(`   connected to ${host}:${port} (unit ${workingUnit})`);

    // ② Full-map snapshot -----------------------------------------------------
    console.log("\n② Reading full GenComm map …");
    const first = await client.readAll();
    okReads++;
    lastBatteryV =
      first.readings.find((r) => r.field.key === "batteryV")?.value ?? null;
    printDump(first, args.raw);

    // ③ Optional polling loop -------------------------------------------------
    if (args.count > 1) {
      console.log(
        `\n③ Reading ${args.count}× at ${args.intervalSec}s intervals to prove stable polling…`,
      );
      console.log(`   #1  ${nowIso()}  ${fmtCompact(first)}`);
      for (let i = 2; i <= args.count; i++) {
        await sleep(args.intervalSec * 1000);
        try {
          const r = await client.readAll();
          okReads++;
          lastBatteryV =
            r.readings.find((x) => x.field.key === "batteryV")?.value ?? null;
          console.log(`   #${i}  ${nowIso()}  ${fmtCompact(r)}`);
        } catch (err) {
          console.log(
            `   #${i}  ${nowIso()}  ❌ ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      console.log(`\n   read OK: ${okReads}/${args.count}`);
    }
  } finally {
    await client.close();
  }

  printVerdict(lastBatteryV, okReads);
  process.exit(0); // don't let a lingering socket hold the CLI open
}

main().catch((err) => {
  console.error(
    `\n❌ ${err instanceof Error ? err.message : String(err)}\n` +
      "   If reads fail, first check the Teleport VPN is up, then that Modbus TCP is\n" +
      "   enabled on the DSE and the unit id is correct (DeepSea default is 10, not 1).",
  );
  process.exit(1);
});
