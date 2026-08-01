"use client";

import { useQuery } from "@tanstack/react-query";
import { runPeriodsQuery } from "@/lib/queries";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration } from "@/lib/charts/temporal";
import { formatSecondsAsDuration } from "@/lib/fe-date-format";
import { formatRunWhen } from "@/lib/run-tracking/run-period-view";
import { formatDollars } from "@/lib/provenance-format";

/**
 * A dashboard panel listing one tracked device's run periods WITHIN the temporal-navigator window —
 * the same D/W/M/Y + prev/next window the charts respect (read via {@link useTemporalRange}). A run
 * that overlaps the window is shown in full.
 *
 * ROLE-GENERIC. `role` selects which detector's periods to list (`generator` runs, `ev` charge
 * sessions); the copy comes in as props because only the caller knows which noun is right. The data
 * path never needed generalising — `/api/device/{id}/run-periods` has always taken `?role=`, and the
 * columns it advertises are planned from the ROWS (units, provenance), not from the role, so an EV
 * session and a generator run render through exactly the same table.
 *
 * The footer totals (count, run-time, kWh) sum the FULL value of every overlapping run — a run that
 * extends before/after the window is counted whole (its energy isn't uniform, so it can't be
 * meaningfully clipped). Such a run is marked with an asterisk and a footnote appears under the
 * table explaining it (only when at least one run is marked).
 *
 * Shown on dashboards whose member device has an enabled run detector (see the `runs` entry in
 * lib/capabilities/catalog.ts). In live mode (D/W) it requests period mode (`1d`/`7d`, stable query
 * key); in historical mode (and always for M/Y) it requests the explicit `start`/`end` range.
 *
 * `runningOverride` carries the live on/off state from the generic latest map (the derived
 * `<role stem>/running` point) so the badge comes from /api/data like every other live value; it
 * falls back to the run-periods response's open-period flag when that point isn't present.
 */
export default function GeneratorRunsCard({
  systemId,
  timezoneOffsetMin,
  role = "generator",
  title = "Generator runs",
  emptyText = "No generator runs in this period",
  activeLabel = "running",
  noun = "run",
  runningOverride,
}: {
  systemId: number;
  timezoneOffsetMin: number;
  /** Which detector's periods to list. Defaults to the generator, this card's only role until EV. */
  role?: string;
  title?: string;
  emptyText?: string;
  /** Badge text while a period is open, e.g. "running" / "charging". */
  activeLabel?: string;
  /** Footer count noun, singular; pluralised with a bare "s" ("run"/"runs", "session"/"sessions"). */
  noun?: string;
  runningOverride?: boolean;
}) {
  const { period, start, end, isHistoricalMode } = useTemporalRange({
    timezoneOffsetMin,
  });

  const { data, isPending, isError } = useQuery(
    runPeriodsQuery(
      isHistoricalMode && start && end
        ? { systemId, role, start, end }
        : {
            systemId,
            role,
            // Live D/W → the run-periods API expects an `Nd` string (`parseInt(period.replace("d",""))`).
            // D→"1d", W→"7d" (M/Y always take the explicit start/end branch above, so never reach here).
            period: `${Math.round(getPeriodDuration(period) / 86_400_000)}d`,
          },
    ),
  );

  // The strict window the navigator is showing, used only to flag runs that extend beyond it.
  const nowMs = Date.now();
  const windowEndMs = isHistoricalMode && end ? Date.parse(end) : nowMs;
  const windowStartMs =
    isHistoricalMode && start
      ? Date.parse(start)
      : nowMs - getPeriodDuration(period);

  // Server returns events oldest-first; show newest-first in the panel. Decorate each with its
  // duration/energy and whether it spans outside the window, and accumulate the (full-value) totals.
  const rows = (data?.events ? [...data.events].reverse() : []).map((e) => {
    const startMs = e.startTimeISO ? Date.parse(e.startTimeISO) : NaN;
    const endMs = e.running
      ? nowMs
      : e.endTimeISO
        ? Date.parse(e.endTimeISO)
        : nowMs;
    const durationSec = e.running
      ? (nowMs - startMs) / 1000
      : (e.durationSeconds ?? null);
    const spansOutside =
      (Number.isFinite(startMs) && startMs < windowStartMs) ||
      endMs > windowEndMs;
    return { e, durationSec, spansOutside };
  });

  const totalSeconds = rows.reduce((s, r) => s + (r.durationSec ?? 0), 0);
  const totalEnergyKwh = rows.reduce((s, r) => s + r.e.energyKwh, 0);
  const anyOutside = rows.some((r) => r.spansOutside);

  // Merging Date+Time into one column frees exactly one slot, so the card can answer "what did that
  // cost?" without getting wider. Gated server-side like every other column: absent, never $0.00.
  const showCost = data?.columns?.cost ?? false;
  // Totals sum only the runs that carry a figure, matching how the footer's other totals behave.
  const totalCostC = rows.reduce<number | null>(
    (s, r) => (r.e.costC == null ? s : (s ?? 0) + r.e.costC),
    null,
  );

  const th = "px-4 py-2 text-xs font-medium text-gray-200";
  const td = "px-4 py-2 text-sm";

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          {title}
          {(runningOverride ?? data?.running) && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              {activeLabel}
            </span>
          )}
        </h2>
      </div>

      {isPending && !data ? (
        // Sized to the empty/short settled body rather than a line of text, so the common case —
        // "nothing in this period" — is a swap rather than a resize. A long run list still grows
        // past this — a known residual (see dashboard-layout-stability.md).
        <div className="px-4 py-6" data-skeleton="" aria-hidden>
          <div className="h-5 w-2/3 animate-pulse rounded bg-gray-700/30" />
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-red-400">
          Failed to load {title.toLowerCase()}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400">{emptyText}</div>
      ) : (
        <>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-700 sticky top-0">
                <tr>
                  <th className={`${th} text-left`}>When</th>
                  <th className={`${th} text-right`}>Duration</th>
                  <th className={`${th} text-right`}>Energy (kWh)</th>
                  {showCost && <th className={`${th} text-right`}>Cost</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {rows.map(({ e, durationSec, spansOutside }, i) => (
                  <tr
                    key={i}
                    className="text-gray-100 odd:bg-gray-800 even:bg-gray-750"
                  >
                    {/* Deliberately NOT whitespace-nowrap: this card sits in a fixed-width
                        dashboard column, and a midnight-crossing run's full
                        "Mon 27 Jul, 23:40 – Tue 28 Jul, 01:15" would set a min-content width that
                        pushes the rightmost column out of the card's `overflow-hidden` box. */}
                    <td className={td}>
                      {formatRunWhen(e)}
                      {spansOutside && (
                        <sup className="text-amber-400 font-semibold">*</sup>
                      )}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {durationSec != null
                        ? formatSecondsAsDuration(durationSec)
                        : "—"}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {e.energyKwh.toFixed(2)}
                    </td>
                    {showCost && (
                      <td className={`${td} text-right tabular-nums`}>
                        {e.costC != null ? formatDollars(e.costC) : "—"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="bg-gray-700 text-gray-100 font-medium border-t border-gray-600">
                  <td className={td}>
                    {rows.length} {rows.length === 1 ? noun : `${noun}s`}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {formatSecondsAsDuration(totalSeconds)}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {totalEnergyKwh.toFixed(2)}
                  </td>
                  {showCost && (
                    <td className={`${td} text-right tabular-nums`}>
                      {totalCostC != null ? formatDollars(totalCostC) : "—"}
                    </td>
                  )}
                </tr>
              </tfoot>
            </table>
          </div>
          {anyOutside && (
            <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-700">
              <span className="text-amber-400 font-semibold">*</span> Run
              extends beyond the selected period; its full duration and energy
              are included in the totals.
            </div>
          )}
        </>
      )}
    </div>
  );
}
