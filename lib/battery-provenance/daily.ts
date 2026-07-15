/**
 * Pure per-day reduction of a battery throughput window — NO database, NO clock, NO IO.
 *
 * The three learners (`eta.ts`, `capacity.ts`, `losses.ts`) each consume only PER-LOCAL-DAY reductions
 * of the raw agg_5m registers; the fits themselves are microseconds. This module computes those
 * reductions ONCE per day so they can be cached in `battery_provenance_daily` and the daily learn reads
 * ~330 tiny rows instead of ~380k agg_5m rows (see docs/architecture/battery-provenance.md).
 *
 * Every reduction is RESUMABLE: each day row carries the tiny seam state the next day's scan needs —
 *   • `socLastSlotPct` — the (already forward-filled) SoC at the day's LAST timeline slot, which is the
 *     `socPct[i-1]` of the next day's first capacity pair (capacity.ts:100-105 pairs across midnight);
 *   • `socCarryPct` + `netAfterSocKwh` — the recal detector's `{prevSoc, netSince}` at day end
 *     (losses.ts#detectRecalDayIndexes resets netSince at every SoC OBSERVATION, which may be days back
 *     across a SoC-dark stretch — the carry may be inherited unchanged through such days).
 * Reducing any suffix (or single day) from the previous row's carry reproduces the one-pass full-window
 * scan bit-for-bit; `EMPTY_CARRY` reproduces the window-start behaviour (capacity's `i === 0` skip,
 * recal's `prevSoc = null`).
 *
 * Day bucketing is the shared end-exclusive convention (eta.ts:90 / capacity.ts:84 / losses.ts:78-81):
 * an interval ENDING exactly at local midnight belongs to the day that just finished.
 */

const DAY_MS = 86_400_000;

/** Structural slice of a battery throughput window (load.ts#BatteryThroughput satisfies it — kept
 *  structural so this module has no runtime dependency on the loader). `soc` is the loader's
 *  forward-filled (≤30 min) series, exactly what the per-interval learners consume. */
export interface ThroughputSlice {
  timeline: number[];
  chargeKwh: number[];
  dischargeKwh: number[];
  soc: (number | null)[];
}

/** Seam state carried from the previous day's reduction into the next. */
export interface DayCarry {
  /** FF SoC at the previous day's last timeline slot (null when its tail was SoC-dark > fill limit). */
  socLastSlotPct: number | null;
  /** Last non-null SoC OBSERVATION value at/before the seam (recal detector's `prevSoc`). */
  socCarryPct: number | null;
  /** Metered net (Σcharge − Σdischarge, kWh) accumulated since that observation (recal `netSince`). */
  netAfterSocKwh: number;
}

/** Window-start carry: reproduces the full-window scan's first-slot behaviour exactly. */
export const EMPTY_CARRY: DayCarry = {
  socLastSlotPct: null,
  socCarryPct: null,
  netAfterSocKwh: 0,
};

/** One local day's reduced learn inputs + carry-out (maps 1:1 onto a battery_provenance_daily row). */
export interface BatteryDayReduction {
  /** Local-day bucket index (days since local epoch — the shared end-exclusive bucketer). */
  dayIndex: number;
  /** The day's first timeline slot (agg_5m interval_end, epoch-ms) — the param step anchor. */
  firstIntervalEndMs: number;
  intervalCount: number;
  /** Ungated Σ over the day's slots (η + losses inputs). */
  chargeKwh: number;
  dischargeKwh: number;
  /** First/last non-null FF SoC in the day + non-null slot count (losses inputs). */
  socFirst: number | null;
  socLast: number | null;
  socSamples: number;
  /** Capacity-fit pair sums, RAIL-GATED (both pair SoCs non-null & < 98; incl. the boundary pair). */
  capDischargeKwh: number;
  downSwingPct: number;
  /** Day contains a BMS-recalibration event (kept out of every fit). */
  recal: boolean;
  /** Carry-out for the next day (see {@link DayCarry}). */
  socLastSlotPct: number | null;
  socCarryPct: number | null;
  netAfterSocKwh: number;
}

/** SoC rail: pairs touching ≥ this SoC are untrusted for the capacity slope (capacity.ts:103). */
const SOC_RAIL_PCT = 98;

/** dayIndex·DAY_MS rendered as a UTC date IS the local calendar date (the agg_1d/flow_1d day key). */
export function dayIndexToDayString(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

export function dayStringToDayIndex(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** Local-day bucket of a timeline slot (end-exclusive: a slot ending AT local midnight belongs to the
 *  day that just finished). */
export function dayIndexOf(tMs: number, tzOffsetMin: number): number {
  return Math.floor((tMs + tzOffsetMin * 60_000 - 1) / DAY_MS);
}

/**
 * The interval-end range OWNED by a local day, as `[startExclusiveMs, endInclusiveMs]`:
 * `dayIndexOf(t) === d  ⇔  startExclusiveMs < t ≤ endInclusiveMs`. NOTE this is the learner/bucketer
 * convention — deliberately NOT `dayToUnixRangeForAggregation`'s 00:05-aligned window, so a
 * non-5-minute-aligned slot in (00:00, 00:05) is never dropped.
 */
export function dayIndexRangeMs(
  dayIndex: number,
  tzOffsetMin: number,
): [number, number] {
  const offMs = tzOffsetMin * 60_000;
  return [dayIndex * DAY_MS - offMs, (dayIndex + 1) * DAY_MS - offMs];
}

/** Drop all slots with `timeline[i] <= fromMsExclusive` (e.g. a lead-in read used only to make the
 *  loader's SoC forward-fill exact at the target's first slots). */
export function sliceThroughput(
  tp: ThroughputSlice,
  fromMsExclusive: number,
): ThroughputSlice {
  let i = 0;
  while (i < tp.timeline.length && tp.timeline[i] <= fromMsExclusive) i++;
  if (i === 0) return tp;
  return {
    timeline: tp.timeline.slice(i),
    chargeKwh: tp.chargeKwh.slice(i),
    dischargeKwh: tp.dischargeKwh.slice(i),
    soc: tp.soc.slice(i),
  };
}

/**
 * Reduce a throughput window to per-local-day learn inputs, resuming from `carryIn`.
 *
 * Replicates, in one pass, exactly the per-day accumulations of the three learners plus the recal
 * detector (with `recalCapacityKwh` — the WINDOW-GLOBAL capacity scalar, the `recalDaysFor` convention
 * that feeds every fit's exclusions):
 *   • η:        ungated Σcharge / Σdischarge                          (eta.ts:95-104)
 *   • capacity: rail-gated pair sums Σdischarge / Σ down-swing        (capacity.ts:92-106)
 *   • losses:   socFirst/socLast/socSamples + the ungated sums        (losses.ts:176-201)
 *   • recal:    {prevSoc, netSince} observation scan                  (losses.ts:95-122)
 *
 * Days with no timeline slots produce NO reduction (they don't exist in the learners either).
 * Deterministic; the same inputs + carry always produce the same rows.
 */
export function reduceThroughputToDays(
  tp: ThroughputSlice,
  tzOffsetMin: number,
  carryIn: DayCarry,
  recalCapacityKwh: number,
  opts: { recalThresholdKwh?: number } = {},
): BatteryDayReduction[] {
  const threshold = opts.recalThresholdKwh ?? 2;
  const n = tp.timeline.length;
  const out: BatteryDayReduction[] = [];
  if (n === 0) return out;

  // Resumable scan state (see DayCarry).
  let prevSlotSoc = carryIn.socLastSlotPct; // capacity pair `socPct[i-1]`
  let prevSoc = carryIn.socCarryPct; // recal detector `prevSoc`
  let netSince = carryIn.netAfterSocKwh; // recal detector `netSince`

  let cur: BatteryDayReduction | null = null;
  for (let i = 0; i < n; i++) {
    const t = tp.timeline[i];
    const d = dayIndexOf(t, tzOffsetMin);
    if (!cur || cur.dayIndex !== d) {
      if (cur) out.push(cur);
      cur = {
        dayIndex: d,
        firstIntervalEndMs: t,
        intervalCount: 0,
        chargeKwh: 0,
        dischargeKwh: 0,
        socFirst: null,
        socLast: null,
        socSamples: 0,
        capDischargeKwh: 0,
        downSwingPct: 0,
        recal: false,
        socLastSlotPct: null,
        socCarryPct: prevSoc,
        netAfterSocKwh: netSince,
      };
    }
    const charge = tp.chargeKwh[i] ?? 0;
    const discharge = tp.dischargeKwh[i] ?? 0;
    const soc = tp.soc[i];

    cur.intervalCount++;
    cur.chargeKwh += charge;
    cur.dischargeKwh += discharge;
    if (soc !== null) {
      if (cur.socFirst === null) cur.socFirst = soc;
      cur.socLast = soc;
      cur.socSamples++;
    }

    // Capacity pair (prev slot, this slot) — attributed to THIS slot's day (capacity.ts:99-105).
    if (
      prevSlotSoc !== null &&
      soc !== null &&
      prevSlotSoc < SOC_RAIL_PCT &&
      soc < SOC_RAIL_PCT
    ) {
      cur.capDischargeKwh += discharge;
      if (prevSlotSoc > soc) cur.downSwingPct += prevSlotSoc - soc;
    }
    prevSlotSoc = soc;

    // Recal detector (losses.ts:106-120 verbatim; C is the window scalar, always > 0 here).
    netSince += charge - discharge;
    if (soc !== null && recalCapacityKwh > 0) {
      if (prevSoc !== null) {
        const implied = ((soc - prevSoc) / 100) * recalCapacityKwh;
        if (Math.abs(implied - netSince) > threshold) cur.recal = true;
      }
      prevSoc = soc;
      netSince = 0;
    }

    // Carry-out fields track the scan state as of the day's last processed slot.
    cur.socLastSlotPct = soc;
    cur.socCarryPct = prevSoc;
    cur.netAfterSocKwh = netSince;
  }
  if (cur) out.push(cur);
  return out;
}
