/**
 * Latest-map paths the DISPLAY layer computes for itself, and which the mechanical serving widening
 * must therefore never supply from a raw point.
 *
 * ## Why this list exists
 *
 * `buildSubscriptionsFromBindings` serves any member-device point whose path nothing else claims.
 * That is right for a genuinely new signal — it is what stops a newly minted point being invisible.
 * It is WRONG for a path the tiles already derive, because the tile layer prefers a real point over
 * its own fallback: `synthesizeMasterLoad` returns null the moment `load/power` exists, and
 * `solarValueFrom` takes a total in preference to summing local+remote. So an unbound raw point
 * arriving here does not add information — it SILENTLY REPLACES a computation nobody chose to
 * retire.
 *
 * ## Why silently replacing it is the wrong default (Kinkora, measured 2026-08-04)
 *
 * Kinkora Unified binds Mondo for solar/battery/grid and Mondo's four load submeters; Fronius is a
 * member but publishes two paths Mondo lacks — `load/power` and `source.solar/power`. Uncontested,
 * so the widening would have served both, moving the Load and Solar tile headlines onto Fronius
 * while the Sankey and every chart stayed on Mondo (they resolve through `area_bindings` via
 * `PointManager._resolvePointsForHandle`, which this module does not touch).
 *
 * The two meters are equally good: over 559 five-minute intervals they agree on averages
 * (battery −65 W vs −85 W, grid 3272 W vs 3227 W) and differ instant-by-instant (mean absolute
 * 467 W battery, 664 W grid) — sampling skew between independently-polled devices, not error.
 *
 * That skew is exactly why a derived quantity must stay inside ONE meter. `rest-of-house` is a
 * subtraction, and subtraction amplifies skew:
 *
 *   today  rest-of-house = (Mondo solar + battery + grid) − Mondo submeters   ← skew cancels
 *   naive  rest-of-house =  Fronius master               − Mondo submeters   ← ~500 W of skew
 *
 * on a residual that averages 1167 W. Hence: excluded by default, and it takes an explicit
 * `area_bindings` row to move a headline onto another device — which carries the charts and the
 * Sankey with it, instead of splitting them.
 *
 * 🛑 A BINDING ALWAYS WINS. This suppresses only the *mechanical* leg. Bind Fronius's `load/power`
 * and it is served, as it should be — the point of the rule is that the choice is made, not drifted
 * into.
 */

/**
 * Paths `components/dashboard/tiles/shared.tsx` synthesizes. Imported by the synthesizers themselves
 * so the two can never disagree about which paths are computed.
 */
export const MASTER_LOAD_PATH = "load/power";
export const REST_OF_HOUSE_PATH = "load.rest-of-house/power";
export const SOLAR_TOTAL_PATH = "source.solar/power";

/**
 * For each derived path, the BOUND inputs whose presence means the display layer is actually
 * deriving it here. Empty ⇒ purely synthetic; no device should ever publish it, so withhold always.
 *
 * 🛑 The suppression is conditional on these, not on "the Area has some binding". An Area whose only
 * binding is unrelated (or stemless) is deriving nothing, so withholding its member's own
 * `source.solar/power` would delete real data to protect a computation that is not happening. Pinned
 * by the stemless-binding test, which caught exactly that over-reach.
 */
const DERIVATION_INPUTS: ReadonlyMap<string, readonly string[]> = new Map([
  // `synthesizeMasterLoad` = max(0, generation + battery + grid) — any one of these bound means the
  // balance is live and a raw master would silently replace it.
  [
    MASTER_LOAD_PATH,
    [
      SOLAR_TOTAL_PATH,
      "source.solar.local/power",
      "source.solar.remote/power",
      "bidi.battery/power",
      "bidi.grid/power",
    ],
  ],
  // `solarValueFrom` falls back to local+remote only when no total exists.
  [SOLAR_TOTAL_PATH, ["source.solar.local/power", "source.solar.remote/power"]],
  // Synthesized from the master minus the child loads; never a vendor point.
  [REST_OF_HOUSE_PATH, []],
]);

/** Paths the display layer can derive. Membership alone does NOT mean "withhold" — see below. */
export const DISPLAY_DERIVED_PATHS: ReadonlySet<string> = new Set(
  DERIVATION_INPUTS.keys(),
);

/**
 * Should the mechanical serving leg withhold `path` from an Area whose BOUND set covers
 * `boundPaths`?
 *
 * True only when the display layer is genuinely deriving this value here — i.e. the Area binds at
 * least one of the inputs it derives from (or the path is purely synthetic). A binding always wins
 * regardless; this decides the unbound leg only.
 */
export function isDisplayDerivedHere(
  path: string,
  boundPaths: ReadonlySet<string>,
): boolean {
  const inputs = DERIVATION_INPUTS.get(path);
  if (inputs === undefined) return false;
  if (inputs.length === 0) return true; // purely synthetic
  return inputs.some((i) => boundPaths.has(i));
}
