"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AmberPriceIndicator,
  getPriceLevel,
  PriceLevel,
} from "./AmberPriceIndicator";
import { formatInTimezone } from "@/lib/date-utils";
import { fromDate, toZoned } from "@internationalized/date";
import { amberQuery } from "@/lib/queries";
import { ttInterphases } from "@/lib/fonts/amber";

interface AmberCardProps {
  systemId: number;
  timezoneOffsetMin: number;
  displayTimezone?: string | null;
}

interface TimeSlot {
  periodEnd: Date;
  priceInCents: number | null;
  renewables: number | null;
  costKwh: number | null;
  incomeKwh: number | null;
  dataQuality: string | null;
  isPast: boolean;
  isMissing: boolean;
}

export default function AmberCard({
  systemId,
  timezoneOffsetMin,
  displayTimezone,
}: AmberCardProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Amber 30-min timeline via React Query. The trailing window + fetch live in the query
  // factory; Amber is "settled but mutable" so it polls on the 30m boundary and re-runs after
  // an Amber-Sync invalidates ['amber', systemId]. Slot-building (a pure transform of the
  // response) lives in a useMemo so the rows stay referentially stable between renders.
  const { data, isPending, isError, error } = useQuery(
    amberQuery({ systemId, displayTimezone }),
  );

  const timeSlots = useMemo<TimeSlot[]>(() => {
    const payload = data as
      | { data?: Array<{ id: string; history?: any }> }
      | undefined;
    if (!payload?.data) return [];

    const findSeries = (needle: string) =>
      payload.data!.find((d) => d.id.includes(needle));
    const priceSeries = findSeries("bidi.grid.import/rate.avg");
    const qualitySeries = findSeries("bidi.grid.import/rate.quality");
    const renewablesSeries = findSeries("bidi.grid.renewables/proportion.avg");
    const costSeries = findSeries("bidi.grid.import/value.avg");
    const incomeSeries = findSeries("bidi.grid.export/value.avg");

    if (!priceSeries || !priceSeries.history) return [];

    const historyStart = new Date(priceSeries.history.firstInterval);
    let priceData: (number | null)[] = priceSeries.history.data;
    let qualityData: (string | null)[] = qualitySeries?.history?.data || [];
    let renewablesData: (number | null)[] =
      renewablesSeries?.history?.data || [];
    let costData: (number | null)[] = costSeries?.history?.data || [];
    let incomeData: (number | null)[] = incomeSeries?.history?.data || [];

    // Trim trailing nulls — keep up to the rightmost index where any series has data.
    let lastValidIndex = -1;
    for (let i = priceData.length - 1; i >= 0; i--) {
      const hasPrice = priceData[i] !== null;
      const hasRenewables = renewablesData[i] !== null;
      const hasUsage = costData[i] !== null || incomeData[i] !== null;
      if (hasPrice || hasRenewables || hasUsage) {
        lastValidIndex = i;
        break;
      }
    }
    if (lastValidIndex >= 0 && lastValidIndex < priceData.length - 1) {
      priceData = priceData.slice(0, lastValidIndex + 1);
      qualityData = qualityData.slice(0, lastValidIndex + 1);
      renewablesData = renewablesData.slice(0, lastValidIndex + 1);
      costData = costData.slice(0, lastValidIndex + 1);
      incomeData = incomeData.slice(0, lastValidIndex + 1);
    }

    const roundedNow = new Date();
    roundedNow.setMinutes(Math.floor(roundedNow.getMinutes() / 30) * 30, 0, 0);

    return priceData.map((value, index) => {
      const slotTime = new Date(
        historyStart.getTime() + index * 30 * 60 * 1000,
      );
      const quality = qualityData[index];
      return {
        periodEnd: slotTime,
        priceInCents: value,
        renewables: renewablesData[index] ?? null,
        costKwh: costData[index] ?? null,
        incomeKwh: incomeData[index] ?? null,
        dataQuality: typeof quality === "string" ? quality : null,
        isPast: slotTime <= roundedNow,
        isMissing: value === null,
      };
    });
  }, [data]);

  const loading = isPending;
  const errorMessage = isError
    ? error instanceof Error
      ? error.message
      : "Failed to load data"
    : null;

  // Auto-scroll to the current interval whenever the slots change.
  useEffect(() => {
    if (timeSlots.length === 0) return;
    const id = setTimeout(() => {
      if (!scrollContainerRef.current) return;
      const currentSlotIndex = timeSlots.findIndex((s) => !s.isPast);
      if (currentSlotIndex > 0) {
        const slotWidth = 53; // 50px width + 3px spacing
        const scrollPosition = currentSlotIndex * slotWidth - 200;
        scrollContainerRef.current.scrollLeft = Math.max(0, scrollPosition);
      }
    }, 100);
    return () => clearTimeout(id);
  }, [timeSlots]);

  if (loading) {
    return (
      <div
        className={`w-full p-4 md:p-6 ${ttInterphases.className}`}
        style={{ backgroundColor: "rgb(40, 49, 66)" }}
      >
        <h2 className="text-lg font-bold text-white mb-4">
          30 MIN FORECAST — GENERAL USAGE
        </h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div
        className={`w-full p-4 md:p-6 ${ttInterphases.className}`}
        style={{ backgroundColor: "rgb(40, 49, 66)" }}
      >
        <h2 className="text-lg font-bold text-white mb-4">
          30 MIN FORECAST — GENERAL USAGE
        </h2>
        <div className="text-red-400">Error: {errorMessage}</div>
      </div>
    );
  }

  return (
    <div
      className={`w-full p-4 md:p-6 ${ttInterphases.className}`}
      style={{ backgroundColor: "rgb(40, 49, 66)" }}
    >
      <h2 className="text-lg font-bold text-white mb-4">
        30 MIN FORECAST — GENERAL USAGE
      </h2>

      <div
        ref={scrollContainerRef}
        className="overflow-x-auto scrollbar-hide"
        style={{ maxWidth: "100%", scrollBehavior: "smooth" }}
      >
        <table
          className="border-separate"
          style={{ borderSpacing: "3px", minWidth: "fit-content" }}
        >
          <tbody>
            {/* Date Row */}
            <tr>
              {timeSlots.map((slot, index) => {
                // Subtract 30 minutes to show interval start (matching Amber's display)
                const intervalEndZoned = toZoned(
                  fromDate(slot.periodEnd, "UTC"),
                  displayTimezone!,
                );
                const intervalStartZoned = intervalEndZoned.subtract({
                  minutes: 30,
                });

                // Check if this is midnight in display timezone
                const isMidnight =
                  intervalStartZoned.hour === 0 &&
                  intervalStartZoned.minute === 0;

                return (
                  <td
                    key={`date-${index}`}
                    width="50"
                    className="text-center"
                    style={{ width: "50px" }}
                  >
                    {isMidnight && (
                      <div
                        className="text-sm font-normal"
                        style={{
                          color: "rgb(156, 163, 175)",
                          opacity: slot.isPast ? 0.4 : 1,
                          fontSize: "14.4px",
                          lineHeight: "16px",
                        }}
                      >
                        {formatInTimezone(
                          intervalStartZoned.toDate(),
                          displayTimezone!,
                          "d MMM",
                        )}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>

            {/* Main Content Row */}
            <tr>
              {timeSlots.map((slot, index) => {
                const priceLevel: PriceLevel = slot.isMissing
                  ? "missing"
                  : getPriceLevel(slot.priceInCents);

                // Check if this is the current interval (first future slot)
                const isCurrent =
                  !slot.isPast && (index === 0 || timeSlots[index - 1]?.isPast);

                // Subtract 30 minutes to show interval start (matching Amber's display)
                const intervalEndZoned = toZoned(
                  fromDate(slot.periodEnd, "UTC"),
                  displayTimezone!,
                );
                const intervalStartZoned = intervalEndZoned.subtract({
                  minutes: 30,
                });

                return (
                  <td
                    key={index}
                    width="50"
                    className="text-center align-top"
                    style={{ width: "50px" }}
                  >
                    <div
                      className="flex flex-col items-center"
                      style={{
                        width: "50px",
                        border: isCurrent
                          ? "1px solid rgba(250, 204, 21, 0.5)"
                          : "none",
                        borderRadius: isCurrent ? "4px" : "0",
                        padding: isCurrent ? "2px" : "0",
                        margin: isCurrent ? "-3px" : "0",
                      }}
                    >
                      {/* Time */}
                      <div
                        className="text-sm font-extrabold mb-2"
                        style={{
                          color: "rgb(229, 229, 229)",
                          opacity: slot.isPast ? 0.4 : 1,
                          fontSize: "14.4px",
                          lineHeight: "16px",
                        }}
                      >
                        {`${String(intervalStartZoned.hour).padStart(2, "0")}:${String(intervalStartZoned.minute).padStart(2, "0")}`}
                      </div>

                      {/* Price Indicator */}
                      <div className="mb-2">
                        <AmberPriceIndicator
                          priceLevel={priceLevel}
                          size={24}
                          isPast={slot.isPast}
                        />
                      </div>

                      {/* Price */}
                      <div
                        className="text-sm font-extrabold mb-2"
                        style={{
                          color: slot.isMissing
                            ? "rgb(156, 163, 175)"
                            : "rgb(255, 255, 255)",
                          opacity: slot.isPast ? 0.4 : 1,
                          fontSize: "14.4px",
                          lineHeight: "16px",
                        }}
                      >
                        {slot.isMissing
                          ? "—"
                          : `${slot.priceInCents?.toFixed(0)}¢`}
                      </div>

                      {/* Renewables % */}
                      <div
                        className="text-sm font-extrabold mb-2"
                        style={{
                          color:
                            slot.renewables !== null
                              ? "rgb(255, 255, 255)"
                              : "rgb(156, 163, 175)",
                          opacity: slot.isPast ? 0.4 : 1,
                          fontSize: "14.4px",
                          lineHeight: "16px",
                        }}
                      >
                        {slot.renewables !== null
                          ? `${slot.renewables.toFixed(0)}%`
                          : "—"}
                      </div>

                      {/* Cost */}
                      <div
                        className="text-sm font-normal"
                        style={{
                          color: "rgb(229, 229, 229)",
                          opacity: slot.isPast ? 0.3 : 0.6,
                          fontSize: "12px",
                          lineHeight: "14px",
                        }}
                      >
                        {slot.costKwh !== null
                          ? `${slot.costKwh.toFixed(1)}`
                          : "—"}
                      </div>

                      {/* Income */}
                      <div
                        className="text-sm font-normal"
                        style={{
                          color: "rgb(229, 229, 229)",
                          opacity: slot.isPast ? 0.3 : 0.6,
                          fontSize: "12px",
                          lineHeight: "14px",
                        }}
                      >
                        {slot.incomeKwh !== null
                          ? `${slot.incomeKwh.toFixed(1)}`
                          : "—"}
                      </div>

                      {/* Data Quality Badge */}
                      {slot.dataQuality && (
                        <div
                          className="mt-1"
                          title={
                            slot.dataQuality === "forecast"
                              ? "Forecast"
                              : slot.dataQuality === "actual"
                                ? "Actual"
                                : slot.dataQuality === "billable"
                                  ? "Billable"
                                  : slot.dataQuality
                          }
                        >
                          <span
                            className="inline-block px-1 text-xs font-bold rounded"
                            style={{
                              backgroundColor:
                                slot.dataQuality === "forecast"
                                  ? "rgba(59, 130, 246, 0.3)"
                                  : slot.dataQuality === "actual"
                                    ? "rgba(34, 197, 94, 0.3)"
                                    : slot.dataQuality === "billable"
                                      ? "rgba(168, 85, 247, 0.3)"
                                      : "rgba(107, 114, 128, 0.3)",
                              color:
                                slot.dataQuality === "forecast"
                                  ? "rgb(147, 197, 253)"
                                  : slot.dataQuality === "actual"
                                    ? "rgb(134, 239, 172)"
                                    : slot.dataQuality === "billable"
                                      ? "rgb(216, 180, 254)"
                                      : "rgb(156, 163, 175)",
                              opacity: slot.isPast ? 0.4 : 1,
                              fontSize: "10px",
                              lineHeight: "12px",
                            }}
                          >
                            {slot.dataQuality.charAt(0).toUpperCase()}
                          </span>
                        </div>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
