"use client";

import { useQuery } from "@tanstack/react-query";
import { runPeriodsQuery } from "@/lib/queries";
import { formatSecondsAsDuration } from "@/lib/fe-date-format";
import { applyExcelFormat } from "@/lib/point/display/excel-format";
import {
  avgPowerWFromEnergy,
  formatRunWhen,
} from "@/lib/run-tracking/run-period-view";
import {
  formatDollars,
  formatKgCo2,
  formatRenewablePct,
} from "@/lib/provenance-format";

/** Average power (W) rendered as kW, 1dp — fixed scale so a column never mixes W and kW rows. */
function kwText(avgPowerW: number | null | undefined): string {
  if (avgPowerW == null) return "—";
  return `${(Math.abs(avgPowerW) / 1000).toFixed(1)}`;
}

/** Renewable ENERGY (kWh) as a share of the energy it came from. Null denominator ⇒ "—". */
function renewablePctText(
  renewableKwh: number | null | undefined,
  energyKwh: number | null | undefined,
): string {
  if (renewableKwh == null || !energyKwh) return "—";
  return formatRenewablePct((100 * renewableKwh) / energyKwh);
}

const TH_LEFT = "px-4 py-3 text-left text-sm font-medium text-gray-200";
const TH_RIGHT = "px-4 py-3 text-right text-sm font-medium text-gray-200";
const TD_NUM = "px-4 py-3 text-sm text-right tabular-nums";

interface AvailableSystem {
  id: number;
  displayName: string;
  vendorSiteId: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

interface GeneratorClientProps {
  systemIdentifier: string; // For display/routing purposes
  system: {
    id: number;
    displayName: string;
  };
  userId: string;
  isAdmin: boolean;
  availableSystems: AvailableSystem[];
}

export default function GeneratorClient({
  systemIdentifier,
  system,
  userId,
  isAdmin,
  availableSystems,
}: GeneratorClientProps) {
  const propSystemId = system.id;

  // Bounded read of persisted run periods (replaces the old unbounded generator-events scan), via
  // the shared run-periods query factory. A non-ok response surfaces as `isError`.
  const {
    data: generatorData,
    isPending,
    isError,
    error: queryError,
  } = useQuery(
    runPeriodsQuery({
      systemId: propSystemId,
      role: "generator",
      period: "30d",
    }),
  );

  const loading = isPending;
  const error = isError
    ? queryError instanceof Error
      ? queryError.message
      : "Unknown error"
    : null;

  // The server decides which columns are honest for this detector (it knows the signal's unit); the
  // table just obeys. Non-null exactly when the signal column should render, so it narrows at use.
  const signalCol = generatorData?.columns?.signal
    ? (generatorData.signal ?? null)
    : null;
  const showAvgPower = generatorData?.columns?.avgPower ?? false;
  const showCost = generatorData?.columns?.cost ?? false;
  const showEmissions = generatorData?.columns?.emissions ?? false;
  const showRenewable = generatorData?.columns?.renewable ?? false;
  const basis = generatorData?.columns?.avgPowerBasis ?? "energy";
  const totalEnergyKwh = generatorData?.totalEnergyKwh ?? 0;
  const totalDurationSeconds = generatorData?.totalDurationSeconds ?? 0;
  const totalCostC = generatorData?.totalCostC ?? null;
  const totalEmissionsG = generatorData?.totalEmissionsG ?? null;
  const totalRenewableKwh = generatorData?.totalRenewableKwh ?? null;
  const costKnownKwh = generatorData?.costKnownKwh ?? 0;
  const emissionsKnownKwh = generatorData?.emissionsKnownKwh ?? 0;
  const renewableKnownKwh = generatorData?.renewableKnownKwh ?? 0;
  // A window can straddle the moment provenance was switched on (or a detector re-point), leaving
  // some runs unpriced. The Energy total still covers every run, so an unmarked cost total would
  // invite dividing the two and reading a tariff far below the real one. Mark it instead.
  const provenancePartial =
    (showCost && totalCostC != null && costKnownKwh < totalEnergyKwh) ||
    (showEmissions &&
      totalEmissionsG != null &&
      emissionsKnownKwh < totalEnergyKwh);
  // A genuine period average: total energy over total RUNNING time (not a mean of per-run means).
  const periodAvgPowerW =
    basis === "energy"
      ? avgPowerWFromEnergy(totalEnergyKwh, totalDurationSeconds)
      : null;

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-800 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-800 flex items-center justify-center">
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Generator Events</h1>

        {!generatorData || generatorData.events.length === 0 ? (
          <div className="text-gray-400">
            No generator runs found in the last 30 days
          </div>
        ) : (
          <>
            <div className="bg-gray-800 rounded-lg overflow-x-auto border border-gray-700">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className={TH_LEFT}>When</th>
                    <th className={TH_RIGHT}>Duration</th>
                    {signalCol && (
                      <th className={`${TH_RIGHT} hidden sm:table-cell`}>
                        Avg {signalCol.label}
                        {signalCol.unit ? ` (${signalCol.unit})` : ""}
                      </th>
                    )}
                    {showAvgPower && (
                      <th className={TH_RIGHT}>Avg Power (kW)</th>
                    )}
                    <th className={TH_RIGHT}>Energy (kWh)</th>
                    {showCost && <th className={TH_RIGHT}>Cost</th>}
                    {showEmissions && (
                      <th className={`${TH_RIGHT} hidden sm:table-cell`}>
                        CO₂ (kg)
                      </th>
                    )}
                    {showRenewable && (
                      <th className={`${TH_RIGHT} hidden sm:table-cell`}>
                        Renewable
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {generatorData.events.map((event, idx) => {
                    const durationSec =
                      event.running && event.startTimeISO
                        ? (Date.now() - Date.parse(event.startTimeISO)) / 1000
                        : (event.durationSeconds ?? null);
                    // A running row has no stored duration yet, so the server can't give it an avg
                    // power — recompute from the live elapsed time rather than showing a dash.
                    const avgPowerW =
                      event.running && basis === "energy"
                        ? avgPowerWFromEnergy(event.energyKwh, durationSec)
                        : event.avgPowerW;
                    return (
                      <tr
                        key={idx}
                        className="text-gray-100 odd:bg-gray-800 even:bg-gray-750 hover:bg-gray-700"
                      >
                        <td className="px-4 py-3 text-sm whitespace-nowrap">
                          {formatRunWhen(event)}
                        </td>
                        <td className={TD_NUM}>
                          {durationSec != null
                            ? formatSecondsAsDuration(durationSec)
                            : "—"}
                        </td>
                        {signalCol && (
                          <td className={`${TD_NUM} hidden sm:table-cell`}>
                            {event.avgSignal != null
                              ? applyExcelFormat(
                                  event.avgSignal,
                                  signalCol.format,
                                )
                              : "—"}
                          </td>
                        )}
                        {showAvgPower && (
                          <td className={TD_NUM}>{kwText(avgPowerW)}</td>
                        )}
                        <td className={TD_NUM}>{event.energyKwh.toFixed(2)}</td>
                        {showCost && (
                          <td className={TD_NUM}>
                            {event.costC != null
                              ? formatDollars(event.costC)
                              : "—"}
                          </td>
                        )}
                        {showEmissions && (
                          <td className={`${TD_NUM} hidden sm:table-cell`}>
                            {event.emissionsG != null
                              ? formatKgCo2(event.emissionsG / 1000)
                              : "—"}
                          </td>
                        )}
                        {showRenewable && (
                          <td className={`${TD_NUM} hidden sm:table-cell`}>
                            {renewablePctText(
                              event.renewableKwh,
                              event.energyKwh,
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  <tr className="bg-gray-700 font-bold text-gray-100">
                    {/* Explicit cells, not a colSpan: the signal column is conditional and a
                        hard-coded span silently desyncs from it. */}
                    <td className="px-4 py-3 text-sm">Total</td>
                    <td className={TD_NUM}>
                      {totalDurationSeconds > 0
                        ? formatSecondsAsDuration(totalDurationSeconds)
                        : "—"}
                    </td>
                    {signalCol && (
                      // Deliberately blank: an unweighted mean of per-run means is not a
                      // meaningful figure, and printing one would be the very dishonesty this
                      // table was fixed to remove.
                      <td className={`${TD_NUM} hidden sm:table-cell`} />
                    )}
                    {showAvgPower && (
                      <td className={TD_NUM}>{kwText(periodAvgPowerW)}</td>
                    )}
                    <td className={TD_NUM}>{totalEnergyKwh.toFixed(2)}</td>
                    {showCost && (
                      <td className={TD_NUM}>
                        {totalCostC != null ? formatDollars(totalCostC) : "—"}
                        {provenancePartial && (
                          <sup className="text-amber-400 font-semibold">*</sup>
                        )}
                      </td>
                    )}
                    {showEmissions && (
                      <td className={`${TD_NUM} hidden sm:table-cell`}>
                        {totalEmissionsG != null
                          ? formatKgCo2(totalEmissionsG / 1000)
                          : "—"}
                        {provenancePartial && (
                          <sup className="text-amber-400 font-semibold">*</sup>
                        )}
                      </td>
                    )}
                    {showRenewable && (
                      <td className={`${TD_NUM} hidden sm:table-cell`}>
                        {/* Over only the energy that HAS a renewable figure — not the period's
                            whole energy, which would dilute the share with unknowns. */}
                        {renewablePctText(totalRenewableKwh, renewableKnownKwh)}
                      </td>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-4 text-sm text-gray-400">
              <p>
                Showing {generatorData.events.length} generator run
                {generatorData.events.length !== 1 ? "s" : ""} over the last 30
                days{generatorData.running ? " — running now" : ""}.
              </p>
              <p className="mt-1">
                Consecutive readings within 120 seconds are grouped into one
                run.
              </p>
              <p className="mt-1">
                {basis === "energy"
                  ? "Avg Power is each run’s energy divided by its duration."
                  : "Avg Power is the average of the signal samples over the run."}
                {signalCol
                  ? ` Avg ${signalCol.label} is the mean of the raw ${signalCol.unit || signalCol.metricUnit} samples the detector follows; it is blank for runs recorded by an earlier detector version, whose units cannot be confirmed.`
                  : ""}
              </p>
              {(showCost || showEmissions || showRenewable) && (
                <p className="mt-1">
                  Cost, CO₂ and renewable share are accumulated over each run’s
                  metered energy at this site’s configured generator intensity,
                  at the time the run was recorded.
                  {provenancePartial && (
                    <>
                      {" "}
                      <span className="text-amber-400 font-semibold">
                        *
                      </span>{" "}
                      Some runs in this period have no figure, so the total
                      covers less than the {totalEnergyKwh.toFixed(2)} kWh
                      shown.
                    </>
                  )}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
