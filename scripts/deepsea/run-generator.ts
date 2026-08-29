#!/usr/bin/env npx tsx
/**
 * QUICK AND DIRTY — remote start the Daylesford generator, run it, stop it.
 *
 * ⚠️ THIS PHYSICALLY CRANKS AND RUNS AN ENGINE. Only run it while on site with eyes on
 * the set. It is the first thing in this repo that WRITES to the DSE (everything else is
 * FC3 read-only).
 *
 *   npx tsx scripts/deepsea/run-generator.ts                 # 3 min, asks for confirmation
 *   npx tsx scripts/deepsea/run-generator.ts --minutes=1
 *   npx tsx scripts/deepsea/run-generator.ts --host=10.0.1.244 --unit=10
 *   npx tsx scripts/deepsea/run-generator.ts --dry-run       # pre-flight only, no writes
 *
 * Sequence (per DSE 056-051 issue 4 — DSE's doc, not in this repo; ask support@deepseaplc.com):
 *   1. read the SCF support map (4096–4103) and confirm fns 1/32/33 are supported
 *   2. FC16 write [35701, 29834] → Select Auto mode
 *   3. FC16 write [35732, 29803] → Telemetry Start (in Auto)
 *   4. poll until running, hold for --minutes
 *   5. FC16 write [35733, 29802] → Cancel Telemetry Start → controller runs its own
 *      cool-down and stops. Ctrl-C does the same thing on the way out.
 *
 * We deliberately never send Select Stop (fn 0): that would leave the controller in Stop
 * mode after we exit, i.e. unable to auto-start for the house. Cancel-telemetry-start
 * leaves it in Auto where it belongs.
 */

import ModbusRTU from "modbus-serial";
import * as readline from "node:readline/promises";

const HOST = argStr("host", process.env.DEEPSEA_HOST ?? "10.0.1.244");
const PORT = argNum("port", Number(process.env.DEEPSEA_PORT ?? 502));
const UNIT = argNum("unit", Number(process.env.DEEPSEA_UNIT_ID ?? 10)); // DSE default is 10, not 1
const MINUTES = argNum("minutes", 3);
const DRY_RUN = argBool("dry-run");
const YES = argBool("yes");

// Page 16 control registers (056-051 §3)
const CTRL_KEY_ADDR = 4104; // system control key    (write-only)
const SCF_MAP_ADDR = 4096; // SCF support map, 8 regs (read-only)
const KEY_BASE = 35700;

const FN = {
  STOP: 0,
  AUTO: 1,
  MANUAL: 2,
  START: 5,
  TELEMETRY_START: 32,
  TELEMETRY_CANCEL: 33,
};

// Read registers (page*256 + offset), see scripts/modbus-registers.md
const R = {
  controlMode: 772,
  batteryV: 1029,
  rpm: 1030,
  freqHz: 1031,
  powerW: 1536, // s32, medium confidence
};

const client = new ModbusRTU();
let started = false; // have we issued a start command?
let stopped = false;

function argStr(name: string, dflt: string): string {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split("=").slice(1).join("=") : dflt;
}
function argNum(name: string, dflt: number): number {
  const v = argStr(name, String(dflt));
  const n = Number(v);
  if (!Number.isFinite(n))
    throw new Error(`--${name} must be a number, got ${v}`);
  return n;
}
function argBool(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString("en-AU", { hour12: false });
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);

async function readU16(addr: number): Promise<number> {
  const res = await client.readHoldingRegisters(addr, 1);
  return res.data[0];
}

async function readS32(addr: number): Promise<number | null> {
  const res = await client.readHoldingRegisters(addr, 2);
  const raw = ((res.data[0] << 16) | res.data[1]) >>> 0;
  if (raw >= 0x7ffffff8) return null; // top-8 sentinel band
  return raw > 0x7fffffff ? raw - 0x100000000 : raw;
}

/** Write a control key + its one's complement in a single FC16, per 056-051 §3. */
async function sendKey(fn: number, label: string): Promise<void> {
  const key = KEY_BASE + fn;
  const complement = 65535 - key;
  if (DRY_RUN) {
    log(
      `DRY RUN — would write [${key}, ${complement}] to ${CTRL_KEY_ADDR} (${label})`,
    );
    return;
  }
  log(
    `→ ${label}  (fn ${fn}: write [${key}, ${complement}] to ${CTRL_KEY_ADDR}/${CTRL_KEY_ADDR + 1})`,
  );
  await client.writeRegisters(CTRL_KEY_ADDR, [key, complement]);
  await sleep(250); // keys are rate-limited (~10/s)
}

/** SCF support map: fn F lives in register 4096+floor(F/16), bit 15-(F%16). */
async function scfSupported(): Promise<(fn: number) => boolean | null> {
  try {
    const res = await client.readHoldingRegisters(SCF_MAP_ADDR, 8);
    return (fn: number) => ((res.data[fn >> 4] >> (15 - (fn % 16))) & 1) === 1;
  } catch (err) {
    log(
      `⚠️  could not read the SCF support map (${(err as Error).message}) — skipping the pre-check`,
    );
    return () => null;
  }
}

async function snapshot(): Promise<{
  rpm: number;
  freq: number;
  power: number | null;
}> {
  const rpm = await readU16(R.rpm);
  const freq = await readU16(R.freqHz);
  let power: number | null = null;
  try {
    power = await readS32(R.powerW);
  } catch {
    /* medium-confidence register; ignore */
  }
  return {
    rpm: rpm >= 0xfff8 ? 0 : rpm,
    freq: freq >= 0xfff8 ? 0 : freq / 10,
    power,
  };
}

const isRunning = (s: { rpm: number; freq: number }) =>
  s.rpm > 100 || s.freq > 10;

async function shutdown(reason: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (!started) return;
  console.log("");
  log(`STOPPING (${reason})`);
  try {
    await sendKey(
      FN.TELEMETRY_CANCEL,
      "Cancel Telemetry Start → cool-down + stop",
    );
  } catch (err) {
    console.error(
      `\n🛑 FAILED TO SEND THE STOP COMMAND: ${(err as Error).message}\n` +
        `   THE ENGINE MAY STILL BE RUNNING. Stop it at the panel (Stop/Reset button).\n`,
    );
    return;
  }
  // watch it wind down
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const s = await snapshot();
      log(`  cooling down… rpm=${s.rpm} freq=${s.freq.toFixed(1)}Hz`);
      if (!isRunning(s)) {
        log("✅ engine stopped.");
        return;
      }
    } catch {
      /* keep watching */
    }
  }
  console.error(
    `\n🛑 STILL RUNNING 6 min after the stop command.\n` +
      `   Something else is probably commanding the start (the SP-PRO drives digital input A /\n` +
      `   terminal 51). Check the panel — do NOT assume this script stopped it.\n`,
  );
}

async function main() {
  console.log(
    `\nDSE7410 MkII remote run — ${HOST}:${PORT} unit ${UNIT}, ${MINUTES} min${DRY_RUN ? " (DRY RUN)" : ""}\n`,
  );

  await client.connectTCP(HOST, { port: PORT });
  client.setID(UNIT);
  client.setTimeout(5000);

  // ── pre-flight ────────────────────────────────────────────────────────────
  const batteryRaw = await readU16(R.batteryV);
  const mode = await readU16(R.controlMode);
  const pre = await snapshot();
  log(
    `battery ${(batteryRaw / 10).toFixed(1)}V · controlMode ${mode === 0xffff ? "n/a" : mode} · rpm ${pre.rpm} · freq ${pre.freq.toFixed(1)}Hz`,
  );

  if (isRunning(pre)) {
    console.error(
      "\n🛑 The engine is ALREADY RUNNING. Aborting — sort that out first.\n",
    );
    process.exit(1);
  }

  const supports = await scfSupported();
  for (const [fn, name] of [
    [FN.AUTO, "Select Auto"],
    [FN.TELEMETRY_START, "Telemetry Start"],
    [FN.TELEMETRY_CANCEL, "Cancel Telemetry Start"],
  ] as const) {
    const ok = supports(fn);
    log(
      `SCF fn ${fn} (${name}): ${ok === null ? "unknown" : ok ? "supported" : "NOT SUPPORTED"}`,
    );
    if (ok === false && !DRY_RUN) {
      console.error(
        "\n🛑 The controller says it doesn't support that function. Aborting.\n",
      );
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    log("dry run — no writes issued. Exiting.");
    client.close(() => {});
    return;
  }

  if (!YES) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      `\n⚠️  This will START THE GENERATOR and run it for ${MINUTES} minutes.\n` +
        `   Confirm nobody is servicing the set and it is safe to run. Type START to go: `,
    );
    rl.close();
    if (answer.trim() !== "START") {
      console.log("aborted.");
      client.close(() => {});
      return;
    }
  }

  // Ctrl-C / crash → always try to stop
  process.on(
    "SIGINT",
    () => void shutdown("SIGINT").then(() => process.exit(130)),
  );
  process.on(
    "SIGTERM",
    () => void shutdown("SIGTERM").then(() => process.exit(143)),
  );

  // ── start ─────────────────────────────────────────────────────────────────
  started = true;
  await sendKey(FN.AUTO, "Select Auto mode");
  await sleep(1000);
  await sendKey(FN.TELEMETRY_START, "Telemetry Start");

  // ── wait for it to come up (crank + warm-up can take ~30 s) ───────────────
  const upBy = Date.now() + 90_000;
  let running = false;
  while (Date.now() < upBy) {
    await sleep(5000);
    const s = await snapshot();
    log(`  starting… rpm=${s.rpm} freq=${s.freq.toFixed(1)}Hz`);
    if (isRunning(s)) {
      running = true;
      break;
    }
  }
  if (!running) {
    console.error(
      "\n🛑 No sign of the engine running 90 s after the start command.\n",
    );
    await shutdown("failed to start");
    client.close(() => {});
    process.exit(1);
  }

  // ── hold ──────────────────────────────────────────────────────────────────
  const until = Date.now() + MINUTES * 60_000;
  log(
    `✅ RUNNING — holding for ${MINUTES} min (until ${new Date(until).toLocaleTimeString("en-AU", { hour12: false })})`,
  );
  while (Date.now() < until) {
    await sleep(10_000);
    const s = await snapshot();
    const left = Math.max(0, Math.round((until - Date.now()) / 1000));
    log(
      `  rpm=${s.rpm} freq=${s.freq.toFixed(1)}Hz power=${s.power ?? "n/a"}W · ${left}s left`,
    );
    if (!isRunning(s)) {
      console.error(
        "\n⚠️  The engine stopped on its own (alarm? fuel?). Check the panel.\n",
      );
      break;
    }
  }

  await shutdown(`${MINUTES} min elapsed`);
  client.close(() => {});
}

main().catch(async (err) => {
  console.error(`\n💥 ${err instanceof Error ? err.stack : err}\n`);
  await shutdown("script error");
  client.close(() => {});
  process.exit(1);
});
