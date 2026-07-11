#!/usr/bin/env tsx
/**
 * LiveOne collector — reads locally-reachable devices and pushes self-describing readings to gusher
 * (`/api/gush`). Runs on the Fly WireGuard hub (which reaches the DSE), or on the Mac over Teleport.
 *
 * Currently wires the `musher` source (DeepSea Modbus). `fusher` (Fronius) plugs in the same way.
 *
 * Env (.env.local):
 *   GUSH_ENDPOINT           gusher URL (default http://localhost:3000/api/gush)
 *   MUSHER_API_KEY          the system's gusher apiKey (gk_…)   [required unless --dry]
 *   MUSHER_SITE_ID          vendorSiteId (default "sheephouse")
 *   COLLECTOR_INTERVAL_SEC        idle poll interval, boundary-aligned (default 300 = every 5 min)
 *   COLLECTOR_ACTIVE_INTERVAL_SEC poll interval while the generator is running (default 60 = 1 min)
 *   DEEPSEA_HOST/PORT/UNIT_ID   DSE connection (defaults 10.0.1.244 / 502 / 10)
 *
 * Flags:
 *   --once    run a single tick then exit (read → push)
 *   --dry     read + build the reading set and print it; DON'T push (no apiKey needed)
 *   --help
 */

import { createMusher } from "./sources/musher";
import { buildReadings } from "./core/build";
import { Pusher } from "./core/pusher";
import { runLoop, type Entry } from "./core/run";

const HELP = `LiveOne collector — musher (DeepSea Modbus) → gusher (/api/gush)

Usage: npm run collector -- [--once | --dry | --help]

  --once   single tick (read → push) then exit
  --dry    read + print the reading set; do not push (no apiKey needed)
  --help   this help

Env: GUSH_ENDPOINT, MUSHER_API_KEY, MUSHER_SITE_ID, COLLECTOR_INTERVAL_SEC,
     DEEPSEA_HOST/PORT/UNIT_ID (see file header).`;

function num(v: string | undefined): number | undefined {
  return v ? Number(v) : undefined;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log(HELP);
    return;
  }
  const dry = args.has("--dry");
  const once = args.has("--once");

  const endpoint =
    process.env.GUSH_ENDPOINT ?? "http://localhost:3000/api/gush";
  const siteId = process.env.MUSHER_SITE_ID ?? "sheephouse";
  const intervalSec = Number(process.env.COLLECTOR_INTERVAL_SEC ?? "300");
  const activeIntervalSec = Number(
    process.env.COLLECTOR_ACTIVE_INTERVAL_SEC ?? "60",
  );
  const ts = () => new Date().toISOString();
  const log = (m: string) => console.log(`${ts()} ${m}`);

  const musher = createMusher({
    siteId,
    host: process.env.DEEPSEA_HOST,
    port: num(process.env.DEEPSEA_PORT),
    unitId: num(process.env.DEEPSEA_UNIT_ID),
    log: (m) => log(`  [dse] ${m}`),
  });

  // --dry: just read + show what we'd push. No apiKey / no network to LiveOne.
  if (dry) {
    log(`[dry] reading ${siteId} …`);
    const values = await musher.read();
    const readings = buildReadings(musher.manifest, values);
    console.log(
      JSON.stringify({ siteId, measurementTime: ts(), readings }, null, 2),
    );
    process.exit(0);
  }

  const apiKey = process.env.MUSHER_API_KEY;
  if (!apiKey) {
    console.error("Missing MUSHER_API_KEY (or run with --dry).");
    process.exit(1);
  }

  const pusher = new Pusher({
    endpoint,
    siteId,
    apiKey,
    log: (m) => log(`[musher] ${m}`),
  });

  log(
    `collector → ${endpoint}  site=${siteId}  (${once ? "once" : `${intervalSec}s idle / ${activeIntervalSec}s active, boundary-aligned`})`,
  );

  const ok = await pusher.test();
  log(`auth test: ${ok ? "OK" : "FAILED"}`);
  if (!ok) process.exit(2);

  const entries: Entry[] = [{ source: musher, pusher }];
  await runLoop(entries, {
    intervalMs: intervalSec * 1000,
    activeIntervalMs: activeIntervalSec * 1000,
    alignToBoundary: true,
    once,
    log,
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
