/**
 * The pure, client-safe core of the charge-limit UI: what a stored automation MEANS right now,
 * and the one line the tile shows for it.
 *
 * DB-free, React-free, fetch-free, with `nowMs` INJECTED — the `decide.ts` discipline, so every
 * case is table-testable. It lives in `lib/` (not beside its components) for two reasons: jest's
 * roots are lib/app/scripts/packages, so a test under `components/` silently never runs
 * (`lib/control/point-ref.ts` exists for the same reason); and the kWh rule below must be the
 * evaluator's, not a copy of it.
 *
 * ## 🛑 The kWh trap this module exists to avoid
 *
 * `ev.charge/added` (Tesla's `charge_energy_added`) is **energy-above-plug-in-baseline**, not
 * dispensed energy. Measured over 3,871 archived `sessions.response` payloads across 30 days: it
 * is monotonic within a charging leg, but decays with vampire drain while plugged in idle, does
 * NOT reset on a top-up restart, and resets only at the first charge start after a REPLUG. A car
 * re-entering `Charging` on an overnight top-up already reads ~42 kWh against a ~46 ceiling.
 *
 * So the progress figure a user sees is ALWAYS `counter − armedContext.baselineKwh`, via the
 * evaluator's own {@link pointProgressKwh}. Rendering "42.5 of 20 kWh" against a freshly armed
 * 20 kWh limit is the defined failure of this feature: the user would read a limit that is
 * already blown, on a charge that has delivered nothing. No baseline (or no counter) ⇒ show the
 * TARGET only and no progress at all — never the raw counter.
 */
import { Area } from "@/lib/ids";
import { pointProgressKwh } from "./decide";

/**
 * The automation row AS IT ARRIVES IN THE BROWSER.
 *
 * Deliberately NOT `AutomationWire` from `./wire`: that type declares `armedAt` &co as `Date`,
 * which is true server-side and a lie on the client — `NextResponse.json` serialises them to ISO
 * strings and `fetchJson` revives nothing (`lib/queries/fetcher.ts`). Mirroring the shape with
 * honest `string` timestamps is the defence against silently doing Date math on a string.
 */
export interface ChargeLimitJson {
  id: string; // au_…
  name: string;
  enabled: boolean;
  mode: string; // "once" | "standing"
  trigger: {
    kind: "charge-session";
    source:
      | { kind: "derivation"; derivationId: string }
      | { kind: "point"; pointId: string };
    afterMinutes?: number;
    afterKwh?: number;
  } | null;
  action: { kind: "point-action"; pointId: string; action: "turn_off" } | null;
  armedAt: string | null;
  lastTriggeredAt: string | null;
  armedContext: { baselineKwh?: number; baselineAt?: number } | null;
}

/**
 * The `ar_` TypeID of the AREA a dashboard datum was served as, or null.
 *
 * `/api/data` is discriminated: a device payload has no `area` leg at all, and the automations
 * resource is area-scoped, so a device-subject tile simply has no limits UI. Validated through the
 * `Area` codec rather than trusted — the `pointIdOf` idiom: an unrecognised shape is ABSENT, never
 * forwarded into a URL.
 */
export function areaIdOfDatum(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const area = (data as { area?: unknown }).area;
  if (typeof area !== "object" || area === null) return null;
  const id = (area as { areaId?: unknown }).areaId;
  if (typeof id !== "string") return null;
  return Area.parse(id).ok ? id : null;
}

/**
 * The subset of an area's automations that target THIS car's charge switch.
 *
 * An area can hold rules for several devices, so the action point is what scopes the list. A row
 * whose action failed to parse server-side arrives with `action: null` (`wire.ts`) — it is
 * excluded from limit logic here, and the dialog lists it separately so it can still be deleted.
 */
export function selectChargeLimits(
  rows: ChargeLimitJson[],
  activePt: string | null,
): ChargeLimitJson[] {
  if (!activePt) return [];
  return rows.filter((r) => r.action?.pointId === activePt);
}

export type ChargeLimitState = "armed" | "waiting" | "stopped" | "off";

export interface ChargeLimitDescription {
  state: ChargeLimitState;
  /** `trigger.afterMinutes` — the configured target, independent of arming. */
  targetMinutes: number | null;
  /** `trigger.afterKwh` — the configured target, independent of arming. */
  targetKwh: number | null;
  /** Whole minutes left before the minutes leg fires. Armed point-source rules only. */
  remainingMinutes: number | null;
  /** kWh delivered since ARM. Armed point-source rules only, and never the raw counter. */
  soFarKwh: number | null;
}

/**
 * What to say about one rule right now.
 *
 * Live progress is available only for a POINT source: its anchor is `armedAt`, a value we wrote
 * and the client can see. A derivation source is anchored on the open run's `start_time`, which
 * moves between recomputes and is server-side only — those rows show targets and nothing else,
 * rather than a number that would be wrong.
 *
 * @param counter the latest `ev.charge/added` reading, or null when the KV map has none yet.
 * @param addedPt the `pt_` id of THAT reading — progress is computed only when it is genuinely
 *   the trigger's source point, never because the paths happen to look alike.
 */
export function describeChargeLimit(
  row: ChargeLimitJson,
  counter: { valueKwh: number } | null,
  addedPt: string | null,
  nowMs: number,
): ChargeLimitDescription {
  const trigger = row.trigger;
  const armedAtMs = row.armedAt ? Date.parse(row.armedAt) : NaN;
  const armed = row.enabled && Number.isFinite(armedAtMs);

  const state: ChargeLimitState = row.enabled
    ? armed
      ? "armed"
      : "waiting"
    : row.lastTriggeredAt
      ? "stopped"
      : "off";

  const targetMinutes = trigger?.afterMinutes ?? null;
  const targetKwh = trigger?.afterKwh ?? null;

  // Only an armed POINT source has a client-visible anchor and baseline.
  const live =
    state === "armed" &&
    trigger != null &&
    trigger.source.kind === "point" &&
    trigger.source.pointId === addedPt;

  let remainingMinutes: number | null = null;
  let soFarKwh: number | null = null;

  if (live) {
    if (targetMinutes != null) {
      const leftMs = targetMinutes * 60_000 - (nowMs - armedAtMs);
      remainingMinutes = Math.max(0, Math.ceil(leftMs / 60_000));
    }
    const baseline = row.armedContext?.baselineKwh;
    if (targetKwh != null && counter && baseline != null) {
      // 🛑 The evaluator's own expression — never `counter.valueKwh`.
      soFarKwh = pointProgressKwh(counter.valueKwh, baseline);
    }
  }

  return { state, targetMinutes, targetKwh, remainingMinutes, soFarKwh };
}

function kwh(n: number): string {
  return n.toFixed(1);
}

/**
 * The tile's one-liner for an armed rule — "Stopping at 20 kWh (12.4 so far)",
 * "Stopping in 34 min", or both legs joined. Null for anything not armed: a rule that is waiting,
 * spent or off has nothing to promise about the charge in progress.
 */
export function formatChargeLimitLine(
  desc: ChargeLimitDescription,
): string | null {
  if (desc.state !== "armed") return null;
  const parts: string[] = [];
  if (desc.targetMinutes != null) {
    parts.push(
      desc.remainingMinutes != null
        ? `in ${desc.remainingMinutes}\u00A0min`
        : `after ${desc.targetMinutes}\u00A0min`,
    );
  }
  if (desc.targetKwh != null) {
    parts.push(
      desc.soFarKwh != null
        ? `at ${kwh(desc.targetKwh)} kWh (${kwh(desc.soFarKwh)} so far)`
        : `at ${kwh(desc.targetKwh)} kWh`,
    );
  }
  if (parts.length === 0) return null;
  return `Stopping ${parts.join(" · ")}`;
}

/**
 * The same fact in the width a 180px tile can hold: "→ 12.4 / 20 kWh" or "→ 34 min".
 * Null when there is nothing armed to say.
 */
export function formatChargeLimitCompact(
  desc: ChargeLimitDescription,
): string | null {
  if (desc.state !== "armed") return null;
  if (desc.targetKwh != null) {
    return desc.soFarKwh != null
      ? `→ ${kwh(desc.soFarKwh)} / ${kwh(desc.targetKwh)} kWh`
      : `→ ${kwh(desc.targetKwh)} kWh`;
  }
  if (desc.targetMinutes != null) {
    return desc.remainingMinutes != null
      ? `→ ${desc.remainingMinutes}\u00A0min`
      : `→ ${desc.targetMinutes}\u00A0min`;
  }
  return null;
}

/**
 * A rule's configured targets as words: "30 min", "20 kWh", or "30 min or 20 kWh".
 * (The create form and the rule list share this so a rule reads back exactly as it was typed.)
 */
export function targetWords(minutes?: number, kwhTarget?: number): string {
  const parts: string[] = [];
  if (minutes != null) parts.push(`${minutes}\u00A0min`);
  if (kwhTarget != null) parts.push(`${kwhTarget} kWh`);
  return parts.join(" or ");
}

/**
 * The create form's live promise, above its one Set-limit button — a complete sentence in the
 * user's own numbers, so the button never needs explaining: "Will stop this charge after 15 min
 * or 6 kWh." / "Will stop every charge after 30 min." Null while there is nothing to promise.
 */
export function summaryWords(
  mode: "once" | "standing",
  minutes?: number,
  kwhTarget?: number,
): string | null {
  const target = targetWords(minutes, kwhTarget);
  if (!target) return null;
  const scope = mode === "once" ? "this charge" : "every charge";
  return `Will stop ${scope} after ${target}.`;
}

/**
 * Display order: armed first (the live one), then waiting, then spent/off, then by name.
 *
 * `au_` ids are uuid**v4** and the wire carries no `createdAt`, so there is no recency to sort by
 * — pretending otherwise would order the list arbitrarily but confidently.
 */
const STATE_RANK: Record<ChargeLimitState, number> = {
  armed: 0,
  waiting: 1,
  stopped: 2,
  off: 3,
};

export function compareChargeLimits(
  a: { state: ChargeLimitState; name: string },
  b: { state: ChargeLimitState; name: string },
): number {
  const d = STATE_RANK[a.state] - STATE_RANK[b.state];
  return d !== 0 ? d : a.name.localeCompare(b.name);
}
