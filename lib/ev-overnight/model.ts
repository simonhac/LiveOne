/**
 * EV-overnight advisor — the pure model. NO database, NO clock, NO IO.
 *
 * The question: the car is charging after the sun has gone, so the home battery is feeding it. When
 * must charging stop so that what is left in the battery (above its unusable floor, plus a buffer)
 * still carries the house's TYPICAL overnight load until solar can carry the house the next morning?
 *
 * ## Shape
 *
 * 1. `segmentNights` slices 5-minute samples into NIGHTS — local noon to local noon, keyed by the
 *    evening's local date, slotted by WALL-CLOCK minutes since noon (288 slots). House load follows the
 *    clock, which is why the axis is wall-clock; the sun does not, which costs at most one hour of
 *    overnight load on a DST night (~0.3 kWh at the pilot site, inside the buffer).
 * 2. `calibrateBattery` learns the battery's physics from the same samples: the floor it stops at, the
 *    discharge cap, and — fitted against SoC rather than taken from the nameplate — a DRAIN CURVE,
 *    SoC %/h as a quadratic in battery kW (standby + linear + I²R-like loss). The fit is not optional:
 *    Sigenergy reports power in 0.1 kW steps, an overnight house that reads "200 W" drains the battery
 *    like ~400 W, and at EV rates every kWh costs more SoC than at idle. A single kWh/% (nameplate or
 *    fitted) is wrong in one regime or the other; the quadratic is unbiased in both.
 * 3. `buildProfile` turns the last N valid nights into a typical night: mean house and solar curves,
 *    the typical morning-cover slot, and `needPct[slot]` — the SoC% the battery must still hold at that
 *    slot to reach the morning. That is the MEAN OF EACH NIGHT'S NEED, not the need of the mean curve:
 *    `max(0, house − solar)` is non-linear, and the mean curve would under-state a dull morning.
 * 4. `solveStopTime` walks forward from now, draining the battery by EV + typical house − typical solar
 *    (capped at the discharge limit), and returns the last moment at which stopping still leaves enough.
 *
 * Only the morning ramp of the solar curve is ever used (up to the cover slot). After the battery fills,
 * solar is curtailed to whatever the house draws and stops meaning "available sun" — that part of the
 * curve never enters the need.
 */

export const SLOT_MIN = 5;
export const SLOTS_PER_NIGHT = (24 * 60) / SLOT_MIN; // 288
const SLOT_H = SLOT_MIN / 60;
const NOON_MIN = 12 * 60;

/** One 5-minute interval. `t` is the UTC END of the interval (the history API's convention). */
export interface Sample5m {
  t: number;
  soc: number | null;
  /** + = discharging (LiveOne is inflow-positive). */
  batteryW: number | null;
  solarW: number | null;
  /** + = importing. */
  gridW: number | null;
  /** House load EXCLUDING the EV (Sigenergy `loadPower`). */
  houseW: number | null;
  evW: number | null;
  loadWh?: number | null;
  solarWh?: number | null;
  importWh?: number | null;
  exportWh?: number | null;
  chargeWh?: number | null;
  dischargeWh?: number | null;
  /** Which power series were gap-filled for this slot, if any. */
  filled?: string | null;
}

// ── wall-clock time ────────────────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Local `YYYY-MM-DD` and minute-of-day of instant `ms` in `tz`. */
export function localParts(
  ms: number,
  tz: string,
): { date: string; minute: number } {
  const p: Record<string, string> = {};
  for (const { type, value } of formatter(tz).formatToParts(ms))
    p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minute: Number(p.hour) * 60 + Number(p.minute),
  };
}

function prevDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The night an instant belongs to and its slot within it. Uses the interval START (`t − 5 min`) for a
 * history sample, so pass `sample.t - SLOT_MIN * 60_000` for those; pass a plain instant otherwise.
 */
export function nightSlot(
  ms: number,
  tz: string,
): { night: string; slot: number } {
  const { date, minute } = localParts(ms, tz);
  const sinceNoon = minute - NOON_MIN;
  return sinceNoon >= 0
    ? { night: date, slot: Math.floor(sinceNoon / SLOT_MIN) }
    : {
        night: prevDate(date),
        slot: Math.floor((sinceNoon + 24 * 60) / SLOT_MIN),
      };
}

export const slotOf = (hh: number, mm = 0): number =>
  Math.floor(((((hh * 60 + mm - NOON_MIN) % 1440) + 1440) % 1440) / SLOT_MIN);

// ── nights ─────────────────────────────────────────────────────────────────────────────────────

export interface Night {
  /** Local date of the evening. */
  key: string;
  /** Index = slot (0 = 12:00–12:05 local). Missing slots are null (DST, outages). */
  slots: (Sample5m | null)[];
}

export function segmentNights(samples: Sample5m[], tz: string): Night[] {
  const byKey = new Map<string, Night>();
  for (const s of samples) {
    const { night, slot } = nightSlot(s.t - SLOT_MIN * 60_000, tz);
    let n = byKey.get(night);
    if (!n) {
      n = { key: night, slots: new Array(SLOTS_PER_NIGHT).fill(null) };
      byKey.set(night, n);
    }
    n.slots[slot] = s;
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Where we start looking for the morning (03:00) and give up (11:00). */
const MORNING_SEARCH_FROM = slotOf(3);
const MORNING_SEARCH_TO = slotOf(11);
/** Solar must beat the house for this many consecutive slots (15 min) to count as "carrying it". */
const COVER_RUN = 3;
const COVER_MIN_SOLAR_W = 100;

/**
 * The first slot of the morning at which solar carries the house — `solar ≥ house` (and solar is
 * actually up) for `COVER_RUN` consecutive slots. Null when the data has a hole or the sun never wins.
 * The morning ramp is uncurtailed (the battery is still filling), so this is a fair read of the sun.
 */
export function morningCoverSlot(n: Night): number | null {
  for (let k = MORNING_SEARCH_FROM; k <= MORNING_SEARCH_TO; k++) {
    let ok = true;
    for (let j = k; j < k + COVER_RUN; j++) {
      const s = n.slots[j];
      if (!s || s.solarW === null || s.houseW === null) return null;
      if (s.solarW < COVER_MIN_SOLAR_W || s.solarW < s.houseW) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return null;
}

/** First slot of the evening window a night must be complete over to be usable (15:00). */
const EVENING_FROM = slotOf(15);

export interface NightNeed {
  key: string;
  coverSlot: number;
  /** Per slot, the SoC% the battery must still hold (above the floor) to reach `coverSlot`. */
  needPct: number[];
  /** Per slot, the house energy (kWh, AC) still to be supplied before `coverSlot`. */
  needKwh: number[];
  houseW: number[];
  solarW: number[];
}

/**
 * One night's overnight need, or null if it is not usable (a hole between 15:00 and cover, or no
 * cover found). `needPct[k] = Σ_{j=k}^{cover−1} drainPctPerH(max(0, house − solar)) · Δt`.
 */
export function nightNeed(
  n: Night,
  battery: Pick<BatteryParams, "drain">,
): NightNeed | null {
  const cover = morningCoverSlot(n);
  if (cover === null) return null;
  for (let k = EVENING_FROM; k < cover; k++) {
    const s = n.slots[k];
    if (!s || s.houseW === null || s.solarW === null) return null;
  }
  const needPct = new Array<number>(SLOTS_PER_NIGHT).fill(0);
  const needKwh = new Array<number>(SLOTS_PER_NIGHT).fill(0);
  const houseW = new Array<number>(SLOTS_PER_NIGHT).fill(0);
  const solarW = new Array<number>(SLOTS_PER_NIGHT).fill(0);
  for (let k = 0; k < SLOTS_PER_NIGHT; k++) {
    houseW[k] = n.slots[k]?.houseW ?? 0;
    solarW[k] = n.slots[k]?.solarW ?? 0;
  }
  let pct = 0;
  let kwh = 0;
  for (let k = cover - 1; k >= 0; k--) {
    const deficitW = Math.max(0, houseW[k] - solarW[k]);
    pct += drainPctPerH(battery.drain, deficitW) * SLOT_H;
    kwh += (deficitW * SLOT_H) / 1000;
    needPct[k] = pct;
    needKwh[k] = kwh;
  }
  return { key: n.key, coverSlot: cover, needPct, needKwh, houseW, solarW };
}

// ── battery calibration ────────────────────────────────────────────────────────────────────────

/** SoC %/h drained as a function of battery output: `c0 + c1·kW + c2·kW²`. */
export interface DrainModel {
  c0: number;
  c1: number;
  c2: number;
}

export function drainPctPerH(d: DrainModel, watts: number): number {
  const kw = Math.max(0, watts) / 1000;
  return d.c0 + d.c1 * kw + d.c2 * kw * kw;
}

/** Effective AC kWh delivered per % of SoC at a steady output — for display only. */
export const kWhPerPctAt = (d: DrainModel, watts: number): number =>
  watts / 1000 / drainPctPerH(d, watts);

export interface BatteryParams {
  /** The SoC (%) the battery stops discharging at. */
  floorPct: number;
  /** Discharge cap (W); anything EV + house asks beyond it comes from the grid. */
  maxDischargeW: number;
  drain: DrainModel;
}

export interface CalibrationReport extends BatteryParams {
  fitWindows: number;
  fitRmsePct: number;
  /** Mean residual (actual − predicted ΔSoC%, per 30 min) in windows where the car was charging. */
  evBiasPct: number;
  nonEvBiasPct: number;
  floorSamples: number;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
}

const median = (xs: number[]) => quantile(xs, 0.5);

/** Solve a 3×3 linear system by Gauss–Jordan with partial pivoting. */
function solve3(m: number[][], v: number[]): number[] {
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++)
      if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const k = a[r][c] / a[c][c];
      for (let j = c; j < 4; j++) a[r][j] -= k * a[c][j];
    }
  }
  return a.map((row, i) => row[3] / row[i]);
}

const FIT_WINDOW = 6; // 30 min — long enough for 0.1% SoC steps, short enough to keep EV windows pure

/**
 * Learn the battery's behaviour from history.
 *
 * - **floor**: the median SoC of slots where the battery has stopped (`|battery| < 50 W`) while the
 *   house imports with no sun — it is sitting at its floor, not choosing to idle.
 * - **discharge cap**: the largest output seen at least 3 times (the inverter clips at a round number;
 *   a percentile lands inside the EV band instead).
 * - **drain curve**: least squares over clean 30-minute windows — battery discharging and covering
 *   everything (`|grid| < 50 W`), SoC inside its range so the reading is neither pinned at 100 nor at
 *   the floor, nothing gap-filled, SoC never rising — of `ΔSoC% = Σ (c0 + c1·P + c2·P²)·Δt` with `P = ev + house − solar`
 *   in kW. Fitting EV-charging and quiet-night windows TOGETHER is what identifies the curvature.
 */
export function calibrateBattery(
  samples: Sample5m[],
  fallback: { capacityKwh: number; floorPct: number },
): CalibrationReport {
  const atFloor = samples.filter(
    (s) =>
      s.soc !== null &&
      s.soc < 30 &&
      s.batteryW !== null &&
      Math.abs(s.batteryW) < 50 &&
      (s.gridW ?? 0) >= 100 &&
      (s.solarW ?? 0) < 50,
  );
  const floorPct =
    atFloor.length >= 12
      ? median(atFloor.map((s) => s.soc!))
      : fallback.floorPct;

  const counts = new Map<number, number>();
  for (const s of samples)
    if ((s.batteryW ?? 0) > 0)
      counts.set(s.batteryW!, (counts.get(s.batteryW!) ?? 0) + 1);
  const repeated = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .map(([w]) => w);
  const maxDischargeW = repeated.length ? Math.max(...repeated) : 5000;

  const rows: { f: number[]; y: number; ev: boolean }[] = [];
  const clean = (s: Sample5m) =>
    s.soc !== null &&
    s.houseW !== null &&
    s.solarW !== null &&
    s.evW !== null &&
    Math.abs(s.gridW ?? 0) < 50 &&
    (s.batteryW ?? 0) > 0 &&
    s.soc > floorPct + 3 &&
    s.soc < 98 &&
    !s.filled;
  for (let i = 0; i + FIT_WINDOW < samples.length; i += FIT_WINDOW) {
    const win = samples.slice(i, i + FIT_WINDOW + 1);
    if (win[FIT_WINDOW].t - win[0].t !== FIT_WINDOW * SLOT_MIN * 60_000)
      continue;
    if (!win.every(clean)) continue;
    // SoC cannot rise while the battery discharges; a jump is the BMS re-syncing, not physics.
    if (win.some((s, j) => j > 0 && s.soc! > win[j - 1].soc! + 0.2)) continue;
    const f = [0, 0, 0];
    for (let j = 1; j <= FIT_WINDOW; j++) {
      const kw =
        Math.max(0, win[j].evW! + win[j].houseW! - win[j].solarW!) / 1000;
      f[0] += SLOT_H;
      f[1] += kw * SLOT_H;
      f[2] += kw * kw * SLOT_H;
    }
    rows.push({
      f,
      y: win[0].soc! - win[FIT_WINDOW].soc!,
      ev: win.every((s) => (s.evW ?? 0) > 3000),
    });
  }

  if (rows.length < 30) {
    return {
      floorPct,
      maxDischargeW,
      drain: { c0: 0, c1: 100 / fallback.capacityKwh, c2: 0 },
      fitWindows: rows.length,
      fitRmsePct: NaN,
      evBiasPct: NaN,
      nonEvBiasPct: NaN,
      floorSamples: atFloor.length,
    };
  }
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const B = [0, 0, 0];
  for (const r of rows)
    for (let i = 0; i < 3; i++) {
      B[i] += r.f[i] * r.y;
      for (let j = 0; j < 3; j++) A[i][j] += r.f[i] * r.f[j];
    }
  const [c0, c1, c2] = solve3(A, B);
  const resid = (r: (typeof rows)[number]) =>
    r.y - (c0 * r.f[0] + c1 * r.f[1] + c2 * r.f[2]);
  const meanOf = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  return {
    floorPct,
    maxDischargeW,
    drain: { c0, c1, c2 },
    fitWindows: rows.length,
    fitRmsePct: Math.sqrt(meanOf(rows.map((r) => resid(r) ** 2))),
    evBiasPct: meanOf(rows.filter((r) => r.ev).map(resid)),
    nonEvBiasPct: meanOf(rows.filter((r) => !r.ev).map(resid)),
    floorSamples: atFloor.length,
  };
}

// ── the typical night ──────────────────────────────────────────────────────────────────────────

export interface Profile {
  /** The night keys it was built from. */
  nights: string[];
  houseW: number[];
  solarW: number[];
  /** Mean over nights of each night's need (SoC% above floor) from this slot to its own morning. */
  needPct: number[];
  /** The same need as house energy, kWh. */
  needKwh: number[];
  /** Mean of the nights' cover slots, rounded. */
  coverSlot: number;
  coverSlots: number[];
}

/**
 * The typical night from the last `days` USABLE nights strictly before `beforeNight` (the night being
 * advised on is never part of its own profile). Null if fewer than `minNights` qualify.
 */
export function buildProfile(
  nights: Night[],
  beforeNight: string,
  battery: Pick<BatteryParams, "drain">,
  days = 7,
  minNights = 4,
): Profile | null {
  const needs: NightNeed[] = [];
  for (let i = nights.length - 1; i >= 0 && needs.length < days; i--) {
    if (nights[i].key >= beforeNight) continue;
    const need = nightNeed(nights[i], battery);
    if (need) needs.push(need);
  }
  if (needs.length < minNights) return null;
  const mean = (pick: (n: NightNeed) => number[]) => {
    const out = new Array<number>(SLOTS_PER_NIGHT).fill(0);
    for (const n of needs) {
      const arr = pick(n);
      for (let k = 0; k < SLOTS_PER_NIGHT; k++) out[k] += arr[k] / needs.length;
    }
    return out;
  };
  const coverSlots = needs.map((n) => n.coverSlot);
  return {
    nights: needs.map((n) => n.key).reverse(),
    houseW: mean((n) => n.houseW),
    solarW: mean((n) => n.solarW),
    needPct: mean((n) => n.needPct),
    needKwh: mean((n) => n.needKwh),
    coverSlot: Math.round(
      coverSlots.reduce((a, b) => a + b, 0) / coverSlots.length,
    ),
    coverSlots,
  };
}

// ── the solver ─────────────────────────────────────────────────────────────────────────────────

export interface SolveInput {
  nowMs: number;
  tz: string;
  socPct: number;
  evW: number;
  battery: BatteryParams;
  /** Extra SoC% held back above the floor. */
  bufferPct: number;
  profile: Profile;
}

export type Solution =
  | {
      kind: "stop-at";
      stopAtMs: number;
      /** SoC% the battery will read at `stopAtMs`. */
      stopSocPct: number;
      /** kWh the car will have taken from now until `stopAtMs`. */
      evKwhFromNow: number;
      /** Typical overnight need from `stopAtMs` to morning, kWh. */
      needKwh: number;
      coverAtMs: number;
    }
  | {
      kind: "stop-now";
      /** kWh the house is expected to import before morning even if charging stops now. */
      shortfallKwh: number;
      needKwh: number;
      requiredSocPct: number;
      coverAtMs: number;
    }
  | {
      /** Already at the floor: nothing left to protect, the house is on the grid regardless. */
      kind: "battery-empty";
      needKwh: number;
      coverAtMs: number;
    }
  | {
      /** Charging could run until the morning cover and the battery would still last. */
      kind: "no-action";
      coverAtMs: number;
    };

/**
 * Walk forward from `nowMs` in 5-minute steps on the typical night. At each step the battery must hold
 * `floor + buffer + needPct[slot]`; while the car charges it drains at `drainPctPerH(min(cap, ev + house
 * − solar))`. The answer is the crossing of the two curves, rounded DOWN to five minutes (advice says
 * "by 10:35", never a minute at which it would already be late).
 */
export function solveStopTime(input: SolveInput): Solution {
  const { nowMs, tz, evW, battery, bufferPct, profile } = input;
  const stepMs = SLOT_MIN * 60_000;
  const base = battery.floorPct + bufferPct;
  const startNight = nightSlot(nowMs, tz).night;

  /** Which typical-night slot an instant falls in, or null once we are past the morning cover. */
  const slotAt = (ms: number): number | null => {
    const { night, slot } = nightSlot(ms, tz);
    if (night !== startNight || slot >= profile.coverSlot) return null;
    return slot;
  };
  let coverAtMs = nowMs;
  for (let i = 0; i < SLOTS_PER_NIGHT && slotAt(coverAtMs) !== null; i++)
    coverAtMs += stepMs;

  const required = (slot: number) => base + profile.needPct[slot];
  const slot0 = slotAt(nowMs);
  if (slot0 === null) return { kind: "no-action", coverAtMs };

  if (input.socPct <= battery.floorPct + 0.5)
    return {
      kind: "battery-empty",
      needKwh: profile.needKwh[slot0],
      coverAtMs,
    };

  const req0 = required(slot0);
  if (input.socPct < req0) {
    const needPct = profile.needPct[slot0];
    const needKwh = profile.needKwh[slot0];
    return {
      kind: "stop-now",
      shortfallKwh:
        needPct > 0
          ? needKwh * Math.min(1, (req0 - input.socPct) / needPct)
          : 0,
      needKwh,
      requiredSocPct: req0,
      coverAtMs,
    };
  }

  // Walk, keeping the trajectory so the stop instant can be interpolated wherever rounding lands it.
  const path: { ms: number; soc: number; evKwh: number; margin: number }[] = [
    { ms: nowMs, soc: input.socPct, evKwh: 0, margin: input.socPct - req0 },
  ];
  let slot: number | null = slot0;
  while (slot !== null) {
    const here = path[path.length - 1];
    const demandW = evW + profile.houseW[slot] - profile.solarW[slot];
    const outW = Math.min(battery.maxDischargeW, Math.max(0, demandW));
    const nextMs = here.ms + stepMs;
    const nextSlot = slotAt(nextMs);
    if (nextSlot === null) return { kind: "no-action", coverAtMs };
    const soc = here.soc - drainPctPerH(battery.drain, outW) * SLOT_H;
    const next = {
      ms: nextMs,
      soc,
      evKwh: here.evKwh + (evW * SLOT_H) / 1000,
      margin: soc - required(nextSlot),
    };
    if (next.margin < 0) {
      const crossMs =
        here.ms + (here.margin / (here.margin - next.margin)) * stepMs;
      const stopAtMs = Math.max(nowMs, Math.floor(crossMs / stepMs) * stepMs);
      const at = interpolate(path.concat(next), stopAtMs);
      return {
        kind: "stop-at",
        stopAtMs,
        stopSocPct: at.soc,
        evKwhFromNow: at.evKwh,
        needKwh: profile.needKwh[slotAt(stopAtMs) ?? slot],
        coverAtMs,
      };
    }
    path.push(next);
    slot = nextSlot;
  }
  return { kind: "no-action", coverAtMs };
}

function interpolate(
  path: { ms: number; soc: number; evKwh: number }[],
  ms: number,
): { soc: number; evKwh: number } {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (ms <= b.ms) {
      const f = Math.max(0, (ms - a.ms) / (b.ms - a.ms));
      return {
        soc: a.soc + (b.soc - a.soc) * f,
        evKwh: a.evKwh + (b.evKwh - a.evKwh) * f,
      };
    }
  }
  return path[path.length - 1];
}
