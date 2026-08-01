/**
 * The pure half of the `heatmap` card (config-v4 Phase 14 stage 20) — config resolution and the
 * PIN RESOLUTION that decides, for a given device's point set, whether a pinned series is honoured,
 * whether the point selector is shown, and whether the "pinned series unavailable" note appears.
 *
 * It lives in lib/ rather than beside the plugin for one concrete reason: jest's `roots` are
 * lib/app/scripts/packages, so anything under components/ is UNTESTABLE by construction (stage 1,
 * finding 2). `components/heatmap/HeatmapPanel.tsx` is a one-line consumer of `resolveHeatmapPin`,
 * and `components/dashboard/cards/heatmap.tsx` is a thin React shell over `resolveHeatmapConfig`.
 *
 * Server-safe: no React, no DOM, no db, and — deliberately — no `lib/heatmap-colors` (ESM-only
 * `d3-scale-chromatic`; see the `HEATMAP_PALETTE_KEYS` note in ./card-types.ts).
 */
import { heatmapConfigSchema, type HeatmapCardConfig } from "./card-types";

/**
 * Parse a card node's opaque `config` (§8.4) into the resolved shape. Both keys are optional, so an
 * absent config resolves to `{}` (the fully-interactive card) rather than failing. `null` ⇒ the
 * config does not satisfy the schema, which the doc validator rejects on write but which a doc
 * persisted by another build could still carry — the plugin renders a notice rather than guessing
 * (in particular it does NOT fall back to "unpinned", which would silently show a device's whole
 * point list on a card whose author asked for exactly one series).
 */
export function resolveHeatmapConfig(
  config: unknown,
): HeatmapCardConfig | null {
  const r = heatmapConfigSchema.safeParse(config ?? {});
  return r.success ? r.data : null;
}

/** What the panel should do with `pinnedSeries`, given the points the device actually has. */
export interface HeatmapPinResolution {
  /** The logical path to draw, or `undefined` for the "select a point" placeholder. */
  series: string | undefined;
  /** Whether to render the point `<Select>`. A honoured pin hides it; an unavailable pin does not. */
  showPointSelect: boolean;
  /**
   * A pin was set and the device does not have it. The panel renders a note AND falls back to the
   * selector; the caller must never pass an unresolvable path down to `HeatmapChart`, which would
   * fetch a series that cannot exist and sit on an empty chart with no explanation.
   */
  pinUnavailable: boolean;
}

/**
 * Resolve the pinned series against a device's point set.
 *
 * 🛑 The "unavailable" arm is the whole reason this is a function rather than
 * `pinnedSeries ?? selected`. A pin is written into a dashboard document; the device's points are
 * live. Re-pointing a card at another device, a vendor renaming a point, or a point going inactive
 * all leave a doc whose pin no longer resolves — a permanent, silent blank card if the pin is
 * honoured regardless. Degrading to the selector keeps the card useful and makes the staleness
 * legible.
 *
 * @param availablePaths the device's logical paths (`/api/device/{id}/points`)
 * @param pinnedSeries   `config.series`, if any
 * @param selectedSeries the panel's card-local selection (user choice or auto-selected first point)
 */
export function resolveHeatmapPin(
  availablePaths: readonly string[],
  pinnedSeries: string | undefined,
  selectedSeries: string | undefined,
): HeatmapPinResolution {
  if (pinnedSeries === undefined) {
    return {
      series: selectedSeries,
      showPointSelect: true,
      pinUnavailable: false,
    };
  }
  if (availablePaths.includes(pinnedSeries)) {
    return {
      series: pinnedSeries,
      showPointSelect: false,
      pinUnavailable: false,
    };
  }
  return {
    series: selectedSeries,
    showPointSelect: true,
    pinUnavailable: true,
  };
}
