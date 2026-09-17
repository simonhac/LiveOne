/**
 * The canonical `bidi.*` power sign, as ONE fact with a provenance, consumed by tests on both
 * sides of the store.
 *
 * 🛑 WHY THIS FILE EXISTS. The convention used to live as bare literals inside whichever test
 * needed it — `importKw(-2300) === 2.3` in the automations suite, `-kw * 1000` in its fixtures,
 * separate numbers again in the flow tests. Nothing tied them together, so each suite could be
 * "corrected" on its own and stay green while disagreeing with the other. That is exactly how the
 * sign question stayed open long enough to produce two wrong conclusions in one afternoon.
 *
 * Importing these constants gives the convention two independent witnesses on OPPOSITE sides of the
 * store: `transformSelectronicData` must WRITE `GRID_IMPORT_W` when the vendor reports import, and
 * `importKw` must READ it as load. Flipping either alone breaks the other; flipping both means
 * editing this file, whose comments say where the numbers came from.
 *
 * The flow builders (`lib/aggregation/flow-series*.ts`) are the obvious third witness and do not
 * use these yet — they still carry their own literals. Worth converging when that suite is next
 * touched; listed here so the gap is a known one rather than an assumed coverage.
 *
 * ── THE CONVENTION ───────────────────────────────────────────────────────────────────────────────
 * `bidi.*` power is POSITIVE for inflow: import from the grid, discharge from the battery.
 * Documented in `docs/architecture/energy-flow-matrix.md` and `docs/architecture/load-calcs.md`.
 *
 * Established at INGEST by each vendor adapter — Sigenergy's `toWInverted`, Selectronic's `gridW`
 * negation — so the stored column is canonical and no reader flips anything. Before 2026-09-17 the
 * Selectronic path stored the vendor's sign and reconciled it at read time via
 * `points.transform = 'i'`, which four consumers applied and a fifth (KV/latest) did not.
 *
 * ── PROVENANCE OF THE NUMBERS ────────────────────────────────────────────────────────────────────
 * Measured at Daylesford (device 1, `pt_5v404b4m93bf8aytkrzvhvs3z1`) during the 2026-09-12
 * generator run: ~3.8 kW flowing from the generator into the house, corroborated by
 * `bidi.grid.import/energy` (`grid_in_wh_total`) rising 0.60 kWh over the same 11 minutes. The
 * whole-history sweep of that point found 534,031 readings of which 16 were the other sign — an
 * off-grid AC input essentially only ever imports, which is what makes the direction unambiguous.
 */

/** Watts on `bidi.grid/power` while the generator supplies the house. Positive = import. */
export const GRID_IMPORT_W = 3813;

/** Watts on `bidi.grid/power` while the site exports. Negative, and NOT generator load. */
export const GRID_EXPORT_W = -2100;

/** Watts on `bidi.battery/power` while the battery discharges. Positive = inflow to the site. */
export const BATTERY_DISCHARGE_W = 419;

/** A minutely series of `kw` of IMPORT, in the canonical stored sign. */
export function importSeriesW(kw: number): number {
  return kw * 1000;
}
