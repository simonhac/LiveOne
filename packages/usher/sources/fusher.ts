/**
 * fusher — the Fronius source (Solar API → gusher).
 *
 * Unlike musher (a thin per-tick read), fusher preserves FroniusPusher's behaviour exactly: it drives
 * a `Site` that **polls each inverter every 2 s** (keeping power/SOC fresh + the energy integrators
 * warm) and, once per minute, produces a **minutely** report of interval energy + instantaneous power.
 * The usher's run-loop harvests that report once per minute via `read()` and pushes it — so poll (2 s)
 * and push (1 min) are decoupled.
 *
 * A single fusher source = one site = one or more inverters (master + slave), aggregated. Its manifest
 * MIRRORS the server-side `FUSHER_POINTS` map exactly (same physicalPathTails / logical stems / units),
 * so an existing Fronius system's `point_info` rows are reused byte-for-byte — the "self-describing"
 * move is simply relocating that map from the receiver to the pusher.
 */

import type { Manifest, Source, Values } from "../core/source";
import { Site, type FroniusInverterConfig } from "../clients/fronius/site";

/**
 * The fusher manifest — a `PointDef[]` mirror of the app's `lib/vendors/fusher/point-metadata.ts`
 * `FUSHER_POINTS`. `key` matches a field on the minutely report (see fusher.read()). Keep this in
 * lock-step with FUSHER_POINTS until the legacy `/api/push/fusher` route is retired.
 */
export const FUSHER_MANIFEST: Manifest = [
  // ── power (W) ──────────────────────────────────────────────────────────────
  {
    key: "solarW",
    physicalPathTail: "solarW",
    logicalPathStem: "source.solar",
    defaultName: "Solar",
    subsystem: "solar",
    metricType: "power",
    metricUnit: "W",
  },
  {
    key: "solarRemoteW",
    physicalPathTail: "solarRemoteW",
    logicalPathStem: "source.solar.remote",
    defaultName: "Solar Remote",
    subsystem: "solar",
    metricType: "power",
    metricUnit: "W",
  },
  {
    key: "solarLocalW",
    physicalPathTail: "solarLocalW",
    logicalPathStem: "source.solar.local",
    defaultName: "Solar Local",
    subsystem: "solar",
    metricType: "power",
    metricUnit: "W",
  },
  {
    key: "loadW",
    physicalPathTail: "loadW",
    logicalPathStem: "load",
    defaultName: "Load",
    subsystem: "load",
    metricType: "power",
    metricUnit: "W",
  },
  {
    key: "batteryW",
    physicalPathTail: "batteryW",
    logicalPathStem: "bidi.battery",
    defaultName: "Battery",
    subsystem: "battery",
    metricType: "power",
    metricUnit: "W",
  },
  {
    key: "gridW",
    physicalPathTail: "gridW",
    logicalPathStem: "bidi.grid",
    defaultName: "Grid",
    subsystem: "grid",
    metricType: "power",
    metricUnit: "W",
  },
  // ── state ──────────────────────────────────────────────────────────────────
  {
    key: "batterySOC",
    physicalPathTail: "batterySOC",
    logicalPathStem: "bidi.battery",
    defaultName: "Battery",
    subsystem: "battery",
    metricType: "soc",
    metricUnit: "%",
  },
  {
    key: "faultCode",
    physicalPathTail: "faultCode",
    logicalPathStem: null,
    defaultName: "Fault",
    subsystem: null,
    metricType: "diagnostic",
    metricUnit: "text",
  },
  {
    key: "faultTimestamp",
    physicalPathTail: "faultTimestamp",
    logicalPathStem: null,
    defaultName: "Fault",
    subsystem: null,
    metricType: "diagnostic",
    metricUnit: "epochMs",
  },
  {
    key: "generatorStatus",
    physicalPathTail: "generatorStatus",
    logicalPathStem: null,
    defaultName: "Generator",
    subsystem: null,
    metricType: "status",
    metricUnit: "bool",
  },
  // ── interval energy (Wh) ─────────────────────────────────────────────────────
  {
    key: "solarWhInterval",
    physicalPathTail: "solarWhInterval",
    logicalPathStem: "source.solar",
    defaultName: "Solar",
    subsystem: "solar",
    metricType: "energy",
    metricUnit: "Wh",
  },
  {
    key: "loadWhInterval",
    physicalPathTail: "loadWhInterval",
    logicalPathStem: "load",
    defaultName: "Load",
    subsystem: "load",
    metricType: "energy",
    metricUnit: "Wh",
  },
  {
    key: "batteryInWhInterval",
    physicalPathTail: "batteryInWhInterval",
    logicalPathStem: "bidi.battery.charge",
    defaultName: "Battery Charge",
    subsystem: "battery",
    metricType: "energy",
    metricUnit: "Wh",
  },
  {
    key: "batteryOutWhInterval",
    physicalPathTail: "batteryOutWhInterval",
    logicalPathStem: "bidi.battery.discharge",
    defaultName: "Battery Discharge",
    subsystem: "battery",
    metricType: "energy",
    metricUnit: "Wh",
  },
  {
    key: "gridInWhInterval",
    physicalPathTail: "gridInWhInterval",
    logicalPathStem: "bidi.grid.import",
    defaultName: "Import",
    subsystem: "grid",
    metricType: "energy",
    metricUnit: "Wh",
  },
  {
    key: "gridOutWhInterval",
    physicalPathTail: "gridOutWhInterval",
    logicalPathStem: "bidi.grid.export",
    defaultName: "Export",
    subsystem: "grid",
    metricType: "energy",
    metricUnit: "Wh",
  },
];

export interface FusherOptions {
  /** gusher vendorSiteId — identifies the LiveOne system (e.g. "kinkora") */
  siteId: string;
  /** the site's inverters (master + slave), addressed by explicit host (no LAN discovery) */
  inverters: FroniusInverterConfig[];
  /** internal inverter poll interval in ms (default 2000 — FroniusPusher's cadence) */
  invPollMs?: number;
  log?: (m: string) => void;
}

export function createFusher(opts: FusherOptions): Source {
  const site = new Site(opts.siteId, opts.inverters, opts.log);
  // Configure (probe + build inverters) then start the internal poll loop. startPolling()
  // self-configures on its first tick, so this also recovers if the tunnel is up but slow.
  site.startPolling(opts.invPollMs ?? 2000);

  return {
    name: "fusher",
    siteId: opts.siteId,
    manifest: FUSHER_MANIFEST,
    async read(): Promise<Values> {
      // Harvest the minutely report (interval since the last harvest). null = baseline/no data yet →
      // nothing to push this minute. Field names match the manifest keys 1:1.
      const m = site.generateFroniusMinutely();
      if (!m) return {};
      return {
        solarW: m.solarW,
        solarRemoteW: m.solarRemoteW,
        solarLocalW: m.solarLocalW,
        loadW: m.loadW,
        batteryW: m.batteryW,
        gridW: m.gridW,
        batterySOC: m.batterySOC,
        faultCode: m.faultCode,
        faultTimestamp: m.faultTimestamp,
        generatorStatus: m.generatorStatus,
        solarWhInterval: m.solarWhInterval,
        loadWhInterval: m.loadWhInterval,
        batteryInWhInterval: m.batteryInWhInterval,
        batteryOutWhInterval: m.batteryOutWhInterval,
        gridInWhInterval: m.gridInWhInterval,
        gridOutWhInterval: m.gridOutWhInterval,
      };
    },
    // Live detail for the inspector (2 s power flow + per-inverter state + minutely history).
    snapshot() {
      return {
        site: site.getSiteData(),
        latestSiteMetrics: site.getLatestSiteMetrics(),
        minutely: site.getFroniusMinutelyHistory(),
      };
    },
  };
}
