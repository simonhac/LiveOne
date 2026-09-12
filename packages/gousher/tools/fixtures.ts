import { transformSelectronicData } from "../../../lib/vendors/selectronic/selectronic-client";
/** Regenerate fixtures with the existing TypeScript implementations. No device/network access. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEEPSEA_MANIFEST,
  deriveDigitalValues,
} from "../../usher/sources/musher";
import { FUSHER_MANIFEST } from "../../usher/sources/fusher";
import { REGISTERS, decodeField } from "../../usher/clients/dse-client";
import { buildReadings } from "../../usher/core/build";
import { SELECTRONIC_POINTS } from "../../../lib/vendors/selectronic/point-metadata";
import {
  SIGENERGY_POINTS,
  sigenergyFlowToData,
} from "../../../lib/vendors/sigenergy/point-metadata";
import { parseEnergyFlow } from "../../../lib/vendors/sigenergy/sigenergy-client";
import { Site } from "../../usher/clients/fronius/site";
import {
  EnergyIntegrator,
  BidirectionalEnergyIntegrator,
} from "../../usher/clients/fronius/energy-integrator";

const output = resolve(__dirname, "../internal/gousher/testdata");
const at = new Date("2026-09-12T00:00:00Z");
function record(source: string, raw: unknown, expected: unknown, extra = {}) {
  return {
    source,
    pollerId: source,
    revision: 1,
    at: at.toISOString(),
    raw,
    harvest: true,
    expected,
    ...extra,
  };
}
function save(source: string, rows: unknown[]) {
  writeFileSync(
    `${output}/${source}.jsonl`,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}
const rawDse = {
  oilPressureKpa: [100],
  coolantTempC: [65526],
  oilTempC: [32767],
  batteryV: [125],
  engineRpm: [1500],
  digInUnnamed1To16: [32768],
  digOutUnnamed1To16: [36864],
  controlMode: [1],
};
const vals: Record<string, number | string | null> = {};
for (const [key, words] of Object.entries(rawDse))
  vals[key] = decodeField(REGISTERS.find((r) => r.key === key)!, words);
deriveDigitalValues(vals);
save("deepsea", [
  record("deepsea", rawDse, buildReadings(DEEPSEA_MANIFEST, vals)),
]);
const rawSigen = [
  {
    data: {
      pvPower: 1.2345,
      batteryPower: -0.5,
      buySellPower: 1,
      loadPower: 2,
      evPower: 0,
      acPower: 2,
      batterySoc: 51.2,
    },
  },
  {
    data: {
      pvPower: null,
      batteryPower: -0.0005,
      batterySoc: false,
      loadPower: "  ",
      evPower: 0,
    },
  },
];
save(
  "sigenergy",
  rawSigen.map((raw) => {
    const data = sigenergyFlowToData(parseEnergyFlow(raw), at);
    return record(
      "sigenergy",
      raw,
      SIGENERGY_POINTS.filter((p) => data[p.field] != null).map((p) => ({
        ...p.metadata,
        value: data[p.field],
      })),
      { expectedAt: at.toISOString() },
    );
  }),
);
const rawSelect = [
  {
    items: {
      solarinverter_w: 1.4,
      shunt_w: 1.4,
      grid_w: -1.5,
      solar_wh_total: 1.2345,
      fault_code: 0,
      fault_ts: 0,
      timestamp: 1789171200,
    },
  },
  { items: { battery_soc: "", load_w: false, timestamp: 1789171200 } },
];
save(
  "selectronic",
  rawSelect.map((raw) => {
    const data = transformSelectronicData(raw);
    return record(
      "selectronic",
      raw,
      SELECTRONIC_POINTS.filter((p) => data[p.field] != null).map((p) => ({
        ...p.metadata,
        value:
          p.metadata.metricType === "energy"
            ? Math.round(data[p.field] * 1000)
            : data[p.field],
      })),
      { expectedAt: data.timestamp.toISOString() },
    );
  }),
);
// Drive the real Site harvest and real integrators with a virtual clock and deterministic inverters.
const site = new Site("fixture", []);
const solar = new EnergyIntegrator();
const battery = new BidirectionalEnergyIntegrator();
const grid = new BidirectionalEnergyIntegrator();
const inverter = {
  getLastPowerData: () => ({
    solarW: 100,
    batteryW: 0,
    gridW: 0,
    batterySoC: 50,
  }),
  getIsMaster: () => true,
  getFaultCode: () => undefined,
  getEnergyData: () => ({
    solarWh: solar.getTotalWh(),
    batteryInWh: battery.getNegativeWh(),
    batteryOutWh: battery.getPositiveWh(),
    gridInWh: grid.getPositiveWh(),
    gridOutWh: grid.getNegativeWh(),
  }),
};
(site as unknown as { inverters: Map<string, unknown> }).inverters.set(
  "fixture",
  inverter,
);
const rows = [];
for (let sec = 0; sec <= 180; sec += 2) {
  const now = new Date(+at + sec * 1000);
  solar.updatePower(100, now);
  battery.updatePower(0, now);
  grid.updatePower(0, now);
  const harvest = sec > 0 && sec % 60 === 0;
  const m = harvest ? site.generateFroniusMinutely() : null;
  rows.push(
    record(
      "fronius",
      {
        master: {
          Body: {
            Data: {
              Site: { P_PV: 100, P_Akku: 0, P_Grid: 0 },
              Inverters: { "1": { SOC: 50 } },
            },
          },
        },
      },
      m
        ? buildReadings(
            FUSHER_MANIFEST,
            m as unknown as Record<string, number | string | null>,
          )
        : [],
      {
        at: now.toISOString(),
        harvest,
        settings: {
          inverters: [{ host: "master", master: true, battery: true }],
          pollMs: 2000,
          pushMs: 60000,
        },
      },
    ),
  );
}
save("fronius", rows);
