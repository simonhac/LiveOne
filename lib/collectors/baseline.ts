import { transformSelectronicData } from "@/lib/vendors/selectronic/selectronic-client";
import { SELECTRONIC_POINTS } from "@/lib/vendors/selectronic/point-metadata";
import { parseEnergyFlow } from "@/lib/vendors/sigenergy/sigenergy-client";
import {
  sigenergyFlowToData,
  SIGENERGY_POINTS,
} from "@/lib/vendors/sigenergy/point-metadata";

// Keep only measurement fields; never export session request bodies or authentication material.
const selectKeys = [
  "solarinverter_w",
  "shunt_w",
  "load_w",
  "battery_w",
  "grid_w",
  "battery_soc",
  "fault_code",
  "fault_ts",
  "gen_status",
  "solar_wh_total",
  "load_wh_total",
  "battery_in_wh_total",
  "battery_out_wh_total",
  "grid_in_wh_total",
  "grid_out_wh_total",
  "timestamp",
];
const sigenKeys = [
  "pvPower",
  "pv_power",
  "solarPower",
  "batteryPower",
  "essPower",
  "batteryChargeDischargePower",
  "buySellPower",
  "gridPower",
  "gridActivePower",
  "loadPower",
  "consumptionPower",
  "evPower",
  "acPower",
  "evsePower",
  "chargerPower",
  "batterySoc",
  "soc",
  "batterySOC",
];
function object(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function keep(v: unknown, keys: string[]) {
  const data = object(v);
  return Object.fromEntries(
    keys.filter((k) => k in data).map((k) => [k, data[k]]),
  );
}
export function baselineFixture(
  source: string,
  response: unknown,
  at: Date,
  pollerId: string,
  revision: number,
) {
  const payload = object(response);
  if (source === "selectronic") {
    const items = keep(payload.items ?? object(payload.raw).items, selectKeys);
    if (!Object.keys(items).length) return null;
    const raw = { items };
    const data = transformSelectronicData(raw, at);
    const expected = SELECTRONIC_POINTS.flatMap((p) => {
      const value = data[p.field];
      return value == null
        ? []
        : [
            {
              ...p.metadata,
              value:
                p.metadata.metricType === "energy"
                  ? Math.round(Number(value) * 1000)
                  : value,
            },
          ];
    });
    return {
      source,
      pollerId,
      revision,
      at: at.toISOString(),
      expectedAt: data.timestamp.toISOString(),
      raw,
      harvest: true,
      expected,
    };
  }
  if (source === "sigenergy") {
    const flow = object(payload.energyFlow ?? response);
    const dataRaw = keep(flow.data ?? flow, sigenKeys);
    if (!Object.keys(dataRaw).length) return null;
    const raw = { data: dataRaw };
    const data = sigenergyFlowToData(parseEnergyFlow(raw), at);
    const expected = SIGENERGY_POINTS.flatMap((p) =>
      data[p.field] == null ? [] : [{ ...p.metadata, value: data[p.field] }],
    );
    return {
      source,
      pollerId,
      revision,
      at: at.toISOString(),
      expectedAt: at.toISOString(),
      raw,
      harvest: true,
      expected,
    };
  }
  return null;
}
