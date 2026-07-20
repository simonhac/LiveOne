/**
 * SoC ↔ meter reconciliation check — the standing monitor behind `batprov_soc_meter_divergence`.
 *
 * Per battery Area and complete local day, the three-term loss model (see `losses.ts`) predicts the
 * SoC-implied stored-energy change from the meters:
 *
 *   ΔSoC/100 · C  ≈  η_c · chargeKwh  −  dischargeKwh  −  idleKwhPerDay
 *
 * A day whose residual exceeds the tolerance means a REAL meter or SoC feed failure (a register gone
 * stale/scaled, a SoC feed lying) — the failure mode the model was built to distinguish from benign
 * losses — or a BMS recalibration snap (flagged `recal`; expected-rare and benign). Judged only on
 * days ≤ 2 days ago (a day mid-heal can't flap), with full SoC coverage, and only when the persisted
 * loss model is armed (η_c/idle/C learned) — an unarmed area is reported, not judged.
 *
 * Structure: a pure reducer over per-day sums + a self-contained loader, called by
 * `monitor-observations`.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { latestArmedDailyParams } from "@/lib/db/planetscale/battery-provenance-daily-pg";
import { loadBatteryThroughput } from "./load";
import { detectRecalDayIndexes } from "./losses";
import { listBatteryProvenanceHandles } from "./recompute";

const DAY_MS = 86_400_000;
/** Judge at most this many complete days per run (bounded work, still catches a persistent fault). */
const MAX_DAYS_JUDGED = 3;
/** A judged day needs at least this many SoC-covered intervals (of 288) to trust its ΔSoC. */
const MIN_DAY_SOC_SAMPLES = 200;

export interface SocMeterDay {
  /** Local calendar day (YYYY-MM-DD). */
  day: string;
  socKwh: number;
  modelKwh: number;
  residualKwh: number;
  /** The residual is a BMS-recalibration snap (benign, expected-rare), not a meter fault. */
  recal: boolean;
}

export interface SocMeterAreaResult {
  handle: number;
  status: "ok" | "divergent" | "unarmed" | "soc-blind" | "no-data";
  etaC?: number;
  idleKwhPerDay?: number;
  capacityKwh?: number;
  daysJudged: number;
  divergentDays: SocMeterDay[];
}

/**
 * Reconcile every battery Area's SoC against its meters over the most recent complete local days
 * (≤ 2 days ago). One throughput read + three indexed param reads per area.
 */
export async function checkSocMeterDivergence(
  nowMs: number,
  tolKwh: number,
): Promise<SocMeterAreaResult[]> {
  const db = requirePlanetscaleDb();
  const handles = await listBatteryProvenanceHandles();
  const out: SocMeterAreaResult[] = [];

  for (const handle of handles) {
    const tp = await loadBatteryThroughput(handle, {
      startMs: nowMs - 8 * DAY_MS,
      endMs: nowMs,
    });
    if (!tp || tp.timeline.length < 2) {
      out.push({ handle, status: "no-data", daysJudged: 0, divergentDays: [] });
      continue;
    }
    if (tp.soc.every((v) => v === null)) {
      out.push({
        handle,
        status: "soc-blind",
        daysJudged: 0,
        divergentDays: [],
      });
      continue;
    }

    // Loss-model params from the daily-state table (fresh within ~7d — the learn writes daily; a
    // long-dead learn must not arm the check). Values are natural ratios/kWh.
    const armed = await latestArmedDailyParams(
      db,
      tp.areaId,
      nowMs,
      tp.timezoneOffsetMin,
    );
    if (armed === null || armed.capacityKwh <= 0) {
      out.push({ handle, status: "unarmed", daysJudged: 0, divergentDays: [] });
      continue;
    }
    const { etaC, idleKwhPerDay: idle, capacityKwh: cap } = armed;

    const offMs = tp.timezoneOffsetMin * 60_000;
    const dayOf = (t: number) => Math.floor((t + offMs - 1) / DAY_MS);
    const recalDays = detectRecalDayIndexes(
      tp.chargeKwh,
      tp.dischargeKwh,
      tp.soc,
      cap,
      tp.timeline,
      tp.timezoneOffsetMin,
    );

    // Per-day sums (ascending), judged only for complete days ≤ 2 days ago with full SoC coverage.
    const maxDay = dayOf(nowMs) - 2;
    const byDay = new Map<
      number,
      {
        chg: number;
        dis: number;
        socFirst: number | null;
        socLast: number | null;
        socN: number;
      }
    >();
    for (let i = 0; i < tp.timeline.length; i++) {
      const d = dayOf(tp.timeline[i]);
      let cur = byDay.get(d);
      if (!cur) {
        cur = { chg: 0, dis: 0, socFirst: null, socLast: null, socN: 0 };
        byDay.set(d, cur);
      }
      cur.chg += tp.chargeKwh[i] ?? 0;
      cur.dis += tp.dischargeKwh[i] ?? 0;
      const soc = tp.soc[i];
      if (soc !== null) {
        if (cur.socFirst === null) cur.socFirst = soc;
        cur.socLast = soc;
        cur.socN++;
      }
    }

    const judged: SocMeterDay[] = [];
    const candidates = [...byDay.keys()]
      .filter((d) => d <= maxDay)
      .sort((a, b) => b - a)
      .slice(0, MAX_DAYS_JUDGED);
    for (const d of candidates) {
      const c = byDay.get(d)!;
      if (
        c.socFirst === null ||
        c.socLast === null ||
        c.socN < MIN_DAY_SOC_SAMPLES
      )
        continue;
      const socKwh = ((c.socLast - c.socFirst) / 100) * cap;
      const modelKwh = etaC * c.chg - c.dis - idle;
      judged.push({
        day: new Date(d * DAY_MS).toISOString().slice(0, 10),
        socKwh: Math.round(socKwh * 100) / 100,
        modelKwh: Math.round(modelKwh * 100) / 100,
        residualKwh: Math.round((socKwh - modelKwh) * 100) / 100,
        recal: recalDays.has(d),
      });
    }

    const divergent = judged.filter((j) => Math.abs(j.residualKwh) > tolKwh);
    out.push({
      handle,
      status: divergent.length > 0 ? "divergent" : "ok",
      etaC,
      idleKwhPerDay: idle,
      capacityKwh: cap,
      daysJudged: judged.length,
      divergentDays: divergent,
    });
  }

  return out;
}
