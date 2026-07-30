/**
 * Per-device CONFIG — the typed, user-editable "all sorts of stuff" blob stored on `devices.config`
 * (jsonb). Distinct from `devices.metadata`, which is the adapter-owned credentials/diagnostics bag
 * (secure-credentials, vendor network, device descriptors). `config` is the clean home for the
 * per-device knobs the capability cleanup is data-driving instead of hardcoding — it grows WITHOUT
 * migrations (the HA `.storage` model), because the column already exists.
 *
 * Today: capability on/off overrides, the structured device `spec` (config-v4 slice K1 — the successor
 * to the free-text `devices.ratings`/`solar_size`/`battery_size` columns, which `devices` does not
 * have), and `nameplateKw`/`updateCadenceSeconds`. `updateCadenceSeconds` is still a forward seam to
 * retire the hardcoded `vendorType === 'enphase' ? 2100 : 300` stale-threshold branch.
 *
 * NOTE (scope): `capabilities` here is a PRESENTATION on/off — force a derived card capability on or off.
 * It is NOT a semantic role remap ("this grid point is really the generator"): that must also flow into
 * the energy-flow matrix + KV paths, so it stays a point/binding-level correction, not a config toggle.
 */
import type { CapabilityId } from "@/lib/capabilities/registry";

/**
 * Off-grid GENERATOR source intensity. For a site whose inverter AC-input (measured as `bidi.grid`) is a
 * generator rather than a mains grid, these constants price that "grid" energy in the battery-provenance
 * model — there is no OpenElectricity/Amber signal off-grid. Read by `loadProvenanceInputs` when the Area
 * has no NEM region. See `docs/architecture/battery-provenance.md` § Off-grid sites + generator. (This is a
 * VALUE knob, not the forbidden role remap — the "bidi.grid is the generator" mapping is a binding-level
 * fact; this only supplies its intensity.)
 */
export interface GeneratorSourceConfig {
  /** Emissions intensity of the generator's electrical output (gCO₂/kWh). */
  emissionsIntensity: number;
  /** Cost of the generator's electrical output (c/kWh). */
  pricePerKwh: number;
  /** Renewable fraction of the output (0..1) — 0 for diesel, > 0 for bio-fuel blends. */
  renewableFraction: number;
}

/**
 * Export (feed-in) tariff — the source of SOLAR OPPORTUNITY COST in the battery-provenance model: charging
 * solar into the battery FORGOES the feed-in revenue you'd have earned exporting it, so opportunity cost =
 * solar charge × feed-in price. The fold consumes only a per-interval export-price series (c/kWh); this
 * config selects where that series comes from. Designed so a future PERSISTED "tariff device" (Option B)
 * drops in with NO fold change — it would merely materialise the same schedule into a `bidi.grid.export/rate`
 * point the loader reads exactly like Amber. See docs/architecture/battery-provenance.md § Opportunity cost.
 */
export type ExportTariffConfig =
  | { mode: "none" } // no opportunity cost (solar valued at 0)
  | { mode: "amber" } // measured Amber feed-in (the bound bidi.grid.export/rate series)
  | { mode: "schedule"; plans: ExportTariffPlan[] }; // retailer schedule, synthesised per interval

/**
 * One retailer tariff VERSION, effective from a local date until the next plan supersedes it. Retailers
 * update feed-in rates periodically; append a new plan (higher `effectiveFrom`) on each change so a
 * historical re-fold prices each interval with the plan that was actually in force. Selection:
 * newest `effectiveFrom` ≤ the interval's local date wins; before the earliest plan → no tariff (null).
 */
export interface ExportTariffPlan {
  /** Local date "YYYY-MM-DD" this plan takes effect; omit for a single always-on plan. */
  effectiveFrom?: string;
  rate: ExportTariffRate;
}

/** Flat (built now) or time-of-use bands (schema reserved; the band evaluator lands with the TOU work). */
export type ExportTariffRate =
  | { kind: "flat"; cPerKwh: number }
  | { kind: "tou"; bands: TouBand[]; defaultCPerKwh: number };

/**
 * A time-of-use band: `cPerKwh` applies within the local clock window [start, end) on the given
 * days/months. RESERVED for the TOU extension (not evaluated yet) — documents the target shape so it drops
 * in without touching the fold. e.g. weekday 17:00–20:00 peak, weekends off-peak, seasonal via `months`.
 */
export interface TouBand {
  cPerKwh: number;
  /** "HH:MM" local (24h). Window is [start, end); wraps past midnight when end ≤ start. */
  start: string;
  end: string;
  /** Days of week the band applies (0=Sun … 6=Sat); omit = all days. */
  days?: number[];
  /** Months the band applies (1 … 12); omit = all months. */
  months?: number[];
}

/** Per-device battery-provenance knobs (off-grid generator source + export tariff for opportunity cost). */
export interface BatteryProvenanceConfig {
  generatorSource?: GeneratorSourceConfig;
  /** Export (feed-in) tariff → solar opportunity cost. Absent ⇒ `{ mode: "none" }` (no opportunity cost). */
  exportTariff?: ExportTariffConfig;
  /**
   * Upper bound (%) on the learned reserve floor — the ASSUMED physical minimum-usable SoC. Absent ⇒
   * `DEFAULT_RESERVE_PCT` (10). The floor is learned per-day as `clamp(lowQuantile(SoC minima) − 2, 5,
   * reserveFloorMaxPct)`; where the battery actually discharges deep this is data-driven, but for a site
   * that never goes below its genset comfort setpoint the true floor is unidentifiable from SoC, so this
   * is the prior. Only raise it if a battery's BMS genuinely reserves more than ~10%. See reserve-floor.ts.
   */
  reserveFloorMaxPct?: number;
}

/**
 * The device's PHYSICAL SPEC, structured — the successor to the three free-text `devices` columns
 * `ratings` / `solar_size` / `battery_size` (clean-sheet §4.8 "what dies": `devices` has no counterpart
 * to any of them, deliberately).
 *
 * Why structured rather than carried across verbatim: the only *behavioural* consumer of the free text
 * is `maxPowerHintFromDeviceInfo`, which regex-scrapes a number back out of strings a vendor scraper
 * happened to produce ("9 kW", "7.5kW, 48V", "11.9kW"). A number that has to be re-parsed on every read
 * is a number that was never stored. Every field here is the value that regex was trying to recover, so
 * the regex retires (config-v4 Phase 12 slice K1) and the strings stop being an interface.
 *
 * All fields optional and absent-when-unknown: absent must keep meaning exactly what an unparseable
 * free-text value meant, or the chart's y-axis hint moves. Non-positive values are never stored (device
 * 3 carries the literal `solar_size` "-0.0 kW", which the old regex also rejected).
 */
export interface DeviceSpec {
  /** PV array nameplate (kW DC) — was `devices.solar_size` ("9 kW"). */
  solarSizeKw?: number;
  /** Battery nominal capacity (kWh) — was `devices.battery_size` ("63.6 kWh"). */
  batterySizeKwh?: number;
  /** Inverter continuous rating (kW) — was the first half of `devices.ratings` ("7.5kW, 48V"). */
  inverterSizeKw?: number;
  /** Battery nominal DC bus voltage (V) — the second half of `devices.ratings`. Display-only. */
  batteryVoltageV?: number;
}

/**
 * Extract the first positive number preceding `unit` from a free-text spec string.
 *
 * The TypeScript counterpart of the `specNum(…)` SQL that used to live in the deleted
 * `lib/registry/v4-mirror.ts`, added in config-v4 Phase 12 slice 1a. It is needed because the two CREATE
 * paths that still receive free text — `POST /api/devices` (from a vendor adapter's `getDeviceInfo`) and
 * the Tesla OAuth callback — used to hand it to `devices.ratings`/`solar_size`/`battery_size` and let the
 * mirror's SQL parse it on the way into `devices.config.spec`. With no `devices` row left to stage it in,
 * the parse has to happen before the write.
 *
 * Semantics are deliberately identical to that SQL, so a device created after 1a gets the same `spec` a
 * device created before it did:
 *   - case-insensitive ("kW" / "kw" / "KWh" all match);
 *   - the FIRST match wins, so "7.5kW, 48V" yields 7.5 for `kw` and 48 for `v`;
 *   - **non-positive and unparseable both collapse to `undefined`**, never 0 — an absent spec field must
 *     mean exactly what an unparseable free-text value meant, or the chart's y-axis hint moves. Device 3
 *     carries the literal `solar_size` "-0.0 kW"; the capture group is unsigned so it reads 0.0, which
 *     this then rejects.
 *
 * One difference from the SQL, and it is a FIX rather than a drift: `kw` here refuses to match the "kw"
 * inside "kwh" (the `(?![a-z])` guard). The SQL pattern had no such guard, so `inverterSizeKw` parsed out
 * of a `ratings` string reading "63.6 kWh" would have picked up the battery figure. No live row exercises
 * it — `ratings` is inverter/voltage text — but reproducing the bug for symmetry would be the wrong call.
 */
function specNum(
  text: string | null | undefined,
  unit: "kw" | "kwh" | "v",
): number | undefined {
  if (!text) return undefined;
  const m = new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${unit}(?![a-z])`, "i").exec(
    text.toLowerCase(),
  );
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Build a {@link DeviceSpec} from the three legacy free-text strings, dropping absent/unparseable fields.
 *
 * Returns `undefined` when nothing parsed, so a caller can spread it without writing an empty `spec: {}`
 * — matching the `nullif(jsonb_strip_nulls(…), '{}')` the SQL version used.
 */
export function specFromLegacyText(input: {
  ratings?: string | null;
  solarSize?: string | null;
  batterySize?: string | null;
}): DeviceSpec | undefined {
  const spec: DeviceSpec = {};
  const solar = specNum(input.solarSize, "kw");
  const battery = specNum(input.batterySize, "kwh");
  const inverter = specNum(input.ratings, "kw");
  const voltage = specNum(input.ratings, "v");
  if (solar !== undefined) spec.solarSizeKw = solar;
  if (battery !== undefined) spec.batterySizeKwh = battery;
  if (inverter !== undefined) spec.inverterSizeKw = inverter;
  if (voltage !== undefined) spec.batteryVoltageV = voltage;
  return Object.keys(spec).length > 0 ? spec : undefined;
}

export interface DeviceConfig {
  /** Force a derived capability ON (true) or OFF (false); absent ⇒ derive from points as normal. */
  capabilities?: Partial<Record<CapabilityId, boolean>>;
  /** Structured physical spec — replaces the free-text `ratings`/`solar_size`/`battery_size`. */
  spec?: DeviceSpec;
  /** Nameplate size (kW) — forward seam to retire the free-text `solar_size`/`ratings` scraping. */
  nameplateKw?: number;
  /** Expected update cadence (seconds) — forward seam to retire the hardcoded vendor stale threshold. */
  updateCadenceSeconds?: number;
  /** Battery-provenance per-device config (currently the off-grid generator source intensity). */
  batteryProvenance?: BatteryProvenanceConfig;
}

/**
 * The line chart's y-axis scaling hint (kW) — the SUCCESSOR to `maxPowerHintFromDeviceInfo`
 * (components/dashboard/cards/shared.tsx), which regex-scrapes the same two numbers out of the free-text
 * `devices.solar_size`/`ratings` on every render. Same rule: the larger of the PV array and the inverter,
 * whichever of the two is known; undefined when neither is.
 *
 * Client-safe (no DB imports) so the card can call it directly once slice K2 puts `config` on the wire.
 * `config.nameplateKw` still outranks this, exactly as it outranks the regex today.
 *
 * ⚠️ Not byte-for-byte the old regex, DELIBERATELY. The old solar pattern was
 * `/^(\d+(?:\.\d+)?)\s+kW$/` — anchored, and requiring a SPACE — so `solar_size` "11.9kW" (Kutis,
 * Sigenergy) silently failed to parse and that chart got no hint at all. The structured parse reads 11.9.
 * Kutis's y-axis therefore changes, and that is the bug being fixed, not a regression. Asserted as a
 * NAMED expected divergence in `scripts/config-v4/verify-slice-k1-parity.ts`; any OTHER device that
 * differs is a failure.
 */
export function maxPowerHintFromSpec(
  spec: DeviceSpec | null | undefined,
): number | undefined {
  const solar = spec?.solarSizeKw;
  const inverter = spec?.inverterSizeKw;
  if (solar !== undefined && inverter !== undefined)
    return Math.max(solar, inverter);
  return solar ?? inverter;
}

/**
 * Render a {@link DeviceSpec} back into the three free-text display strings the WIRE still carries
 * (`/api/data`'s `deviceInfo.ratings`/`solarSize`/`batterySize`, the admin devices table).
 *
 * This is deliberately a one-way DISPLAY projection, not a round-trip. Slice K2 flips the config reads
 * onto `devices`, which has no counterpart to the three columns — but four components still render the
 * strings verbatim (`DeviceInfoTooltip`, `MobileHeaderMenu`, `DeviceLayout`, `AdminDashboardClient`),
 * so dropping them from the payload would silently blank a panel rather than fail a build. Emitting them
 * from the structured spec keeps the payload stable while making `config.spec` the sole SOURCE.
 *
 * The formats reproduce what the vendor scrapers happened to produce ("7.5kW, 48V", "9 kW", "63.6 kWh"),
 * because that is what the components' copy is written around. `undefined` (not `null`) for an absent
 * field, so an unknown spec renders exactly as an unparseable free-text value did — blank, not "0 kW".
 * Retires with the strings themselves in Phase 14.
 */
export function specToDisplayStrings(spec: DeviceSpec | null | undefined): {
  ratings: string | null;
  solarSize: string | null;
  batterySize: string | null;
} {
  const ratingsParts: string[] = [];
  if (spec?.inverterSizeKw !== undefined)
    ratingsParts.push(`${spec.inverterSizeKw}kW`);
  if (spec?.batteryVoltageV !== undefined)
    ratingsParts.push(`${spec.batteryVoltageV}V`);
  return {
    ratings: ratingsParts.length > 0 ? ratingsParts.join(", ") : null,
    solarSize:
      spec?.solarSizeKw !== undefined ? `${spec.solarSizeKw} kW` : null,
    batterySize:
      spec?.batterySizeKwh !== undefined ? `${spec.batterySizeKwh} kWh` : null,
  };
}

/**
 * A device config record widened with the three legacy display strings — the shape the page chrome
 * (`DeviceLayout` → `DeviceInfoTooltip` / `MobileHeaderMenu`) still declares. A function rather than a
 * precomputed const so it composes with TypeScript's narrowing at the call site.
 */
export function withSpecDisplayStrings<
  T extends { config: DeviceConfig | null },
>(device: T): T & ReturnType<typeof specToDisplayStrings> {
  return { ...device, ...specToDisplayStrings(device.config?.spec) };
}

/**
 * Apply a device's capability overrides to a derived set: present+true forces the capability on,
 * present+false forces it off, absent leaves derivation untouched. Returns a new set; a null/empty
 * config is a no-op (so an un-configured device behaves exactly as before — parity preserved).
 */
export function applyCapabilityConfig(
  derived: Set<CapabilityId>,
  config: DeviceConfig | null | undefined,
): Set<CapabilityId> {
  const overrides = config?.capabilities;
  if (!overrides) return derived;
  const out = new Set(derived);
  for (const [cap, enabled] of Object.entries(overrides) as [
    CapabilityId,
    boolean,
  ][]) {
    if (enabled) out.add(cap);
    else out.delete(cap);
  }
  return out;
}
