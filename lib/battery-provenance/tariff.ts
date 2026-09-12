/**
 * The feed-in tariff's SIGN CONVENTION — the one thing left of export-tariff resolution once the
 * tariff became a bound point rather than config.
 *
 * WHAT WAS HERE, AND WHY IT WENT. This module used to turn an `ExportTariffConfig`
 * (`none` | `amber` | `schedule`) into the per-interval `exportPrice[]` series the fold consumes,
 * with a `ScheduleTariffProvider` that synthesised a retailer schedule out of effective-dated plans
 * in `devices.config` jsonb. That was a SECOND implementation of "a price over time" alongside the
 * one the system already has — a point, bound to a role in an area — and the two could disagree:
 * `mode: "amber"` carried no information whatsoever, since it resolved to the very
 * `bidi.grid.export/rate` series the area already binds. An area's feed-in tariff is now simply that
 * bound point, and a site whose tariff is NOT measured will publish one from a tariff device (see
 * docs/plans/block-model.md) rather than describe it in config. Deferred until a residence needs it:
 * no site in the fleet had `mode: "schedule"`, and its time-of-use half threw on use.
 *
 * That deletion also removed a live inconsistency worth recording. Amber's measured
 * `bidi.grid.export/rate` is NEGATIVE when you are being paid, while a schedule plan's `cPerKwh` was
 * a positive receipt — so `mode` was the discriminator that reconciled the sign, and the fold's own
 * opportunity-cost leg (`Math.max(0, exportPrice[i])`, lib/battery-provenance/compute.ts) therefore
 * floored an `amber` site's solar opportunity cost to 0 while giving a `schedule` site a non-zero
 * one. The same physical situation priced two ways, decided by which representation somebody picked.
 * With one source there is one convention and nothing left to discriminate on.
 */

/**
 * The measured feed-in series in the RECEIPTS convention — positive c/kWh = money we RECEIVE — which
 * is what the flow accounting's `revenueC` leg needs.
 *
 * NOT interchangeable with the raw series the fold reads: `bidi.grid.export/rate` is Amber's raw
 * feedIn `perKwh`, negative when you are being paid (`AmberNow.tsx` flips it the same way for
 * display), and the fold consumes it un-normalised. This negation is the whole difference, and it
 * has a name so that the two readings of one series cannot be confused for the same number.
 */
export function exportReceiptSeries(
  exportPrice: (number | null)[],
): (number | null)[] {
  return exportPrice.map((v) => (v === null ? null : -v));
}
