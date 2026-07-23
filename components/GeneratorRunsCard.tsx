"use client";

import { useQuery } from "@tanstack/react-query";
import { runPeriodsQuery } from "@/lib/queries";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration } from "@/lib/charts/temporal";

/** Format a duration in seconds as "2h 30m" / "45m" / "3h". */
function formatDuration(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * A dashboard panel listing a device's generator runs WITHIN the temporal-navigator window — the
 * same D/W/M/Y + prev/next window the charts respect (read via {@link useTemporalRange}). A run
 * that overlaps the window is shown in full.
 *
 * The footer totals (run count, run-time, kWh) sum the FULL value of every overlapping run — a run
 * that extends before/after the window is counted whole (its generation isn't uniform, so it can't
 * be meaningfully clipped). Such a run is marked with an asterisk and a footnote appears under the
 * table explaining it (only when at least one run is marked).
 *
 * Shown on dashboards whose system has an enabled generator tracker (see lib/dashboard/cards.ts
 * "generator-runs"). In live mode (D/W) it requests period mode (`1d`/`7d`, stable query key);
 * in historical mode (and always for M/Y) it requests the explicit `start`/`end` range from the URL.
 *
 * `runningOverride` carries the live running state from the generic latest map (the derived
 * `source.generator/running` point) so the badge comes from /api/data like every other live value;
 * it falls back to the run-periods response's open-period flag when that point isn't present.
 */
export default function GeneratorRunsCard({
  systemId,
  timezoneOffsetMin,
  runningOverride,
}: {
  systemId: number;
  timezoneOffsetMin: number;
  runningOverride?: boolean;
}) {
  const { period, start, end, isHistoricalMode } = useTemporalRange({
    timezoneOffsetMin,
  });

  const { data, isPending, isError } = useQuery(
    runPeriodsQuery(
      isHistoricalMode && start && end
        ? { systemId, role: "generator", start, end }
        : {
            systemId,
            role: "generator",
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

  const th = "px-4 py-2 text-xs font-medium text-gray-200";
  const td = "px-4 py-2 text-sm";

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          Generator runs
          {(runningOverride ?? data?.running) && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              running
            </span>
          )}
        </h2>
      </div>

      {isPending && !data ? (
        <div className="px-4 py-6 text-sm text-gray-400">Loading…</div>
      ) : isError ? (
        <div className="px-4 py-6 text-sm text-red-400">
          Failed to load generator runs
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400">
          No generator runs in this period
        </div>
      ) : (
        <>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-700 sticky top-0">
                <tr>
                  <th className={`${th} text-left`}>Date</th>
                  <th className={`${th} text-left`}>Time</th>
                  <th className={`${th} text-right`}>Duration</th>
                  <th className={`${th} text-right`}>Energy (kWh)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {rows.map(({ e, durationSec, spansOutside }, i) => (
                  <tr
                    key={i}
                    className="text-gray-100 odd:bg-gray-800 even:bg-gray-750"
                  >
                    <td className={td}>{e.date}</td>
                    <td className={td}>
                      {e.running
                        ? `${e.startTime} – now`
                        : e.endTime === null || e.startTime === e.endTime
                          ? e.startTime
                          : `${e.startTime} - ${e.endTime}`}
                      {spansOutside && (
                        <sup className="text-amber-400 font-semibold">*</sup>
                      )}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {durationSec != null ? formatDuration(durationSec) : "—"}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      {e.energyKwh.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="sticky bottom-0">
                <tr className="bg-gray-700 text-gray-100 font-medium border-t border-gray-600">
                  <td className={td}>
                    {rows.length} {rows.length === 1 ? "run" : "runs"}
                  </td>
                  <td className={td} />
                  <td className={`${td} text-right tabular-nums`}>
                    {formatDuration(totalSeconds)}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {totalEnergyKwh.toFixed(2)}
                  </td>
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
