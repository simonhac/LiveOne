"use client";

import { useEffect, useState, useRef } from "react";
import {
  AmberPriceIndicator,
  getPriceLevel,
  PriceLevel,
} from "./AmberPriceIndicator";
import { format } from "date-fns";

interface AmberCardProps {
  systemId: number;
  timezoneOffsetMin: number;
}

interface TimeSlot {
  time: Date;
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
}: AmberCardProps) {
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const now = new Date();

        // Round to 30-minute boundaries
        const minutes = now.getMinutes();
        const roundedMinutes = Math.floor(minutes / 30) * 30;
        const roundedNow = new Date(now);
        roundedNow.setMinutes(roundedMinutes, 0, 0); // Set seconds and ms to 0

        const past24h = new Date(roundedNow.getTime() - 24 * 60 * 60 * 1000);
        const future24h = new Date(roundedNow.getTime() + 24 * 60 * 60 * 1000);

        // Build URL for history API - don't use URLSearchParams to avoid encoding
        const url = `/api/history?systemId=${systemId}&startTime=${past24h.toISOString()}&endTime=${future24h.toISOString()}&interval=30m&series=bidi.grid.import/rate.avg,bidi.grid.import/rate.quality,bidi.grid.renewables/proportion.avg,bidi.grid.import/value.avg,bidi.grid.export/value.avg`;

        const response = await fetch(url, {
          credentials: "same-origin",
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch data: ${response.status}`);
        }

        const data = await response.json();

        // Find import price series (avg is fine for display)
        const priceSeries = data.data?.find((d: any) =>
          d.id.includes("bidi.grid.import/rate.avg"),
        );
        const qualitySeries = data.data?.find((d: any) =>
          d.id.includes("bidi.grid.import/rate.quality"),
        );
        const renewablesSeries = data.data?.find((d: any) =>
          d.id.includes("bidi.grid.renewables/proportion.avg"),
        );
        const costSeries = data.data?.find((d: any) =>
          d.id.includes("bidi.grid.import/value.avg"),
        );
        const incomeSeries = data.data?.find((d: any) =>
          d.id.includes("bidi.grid.export/value.avg"),
        );

        if (!priceSeries || !priceSeries.history) {
          throw new Error("No price data available");
        }

        // Parse the start time from the history data
        const historyStart = new Date(priceSeries.history.start);
        const priceData = priceSeries.history.data;
        const qualityData = qualitySeries?.history?.data || [];
        const renewablesData = renewablesSeries?.history?.data || [];
        const costData = costSeries?.history?.data || [];
        const incomeData = incomeSeries?.history?.data || [];

        // Build time slots from the history data
        const slots: TimeSlot[] = priceData.map(
          (value: number | null, index: number) => {
            const slotTime = new Date(
              historyStart.getTime() + index * 30 * 60 * 1000,
            );
            const quality = qualityData[index];
            return {
              time: slotTime,
              priceInCents: value,
              renewables: renewablesData[index] ?? null,
              costKwh: costData[index] ?? null,
              incomeKwh: incomeData[index] ?? null,
              dataQuality: typeof quality === "string" ? quality : null,
              isPast: slotTime < roundedNow,
              isMissing: value === null,
            };
          },
        );

        setTimeSlots(slots);

        // Auto-scroll to current time after render
        setTimeout(() => {
          if (scrollContainerRef.current) {
            const currentSlotIndex = slots.findIndex((s) => !s.isPast);
            if (currentSlotIndex > 0) {
              const slotWidth = 53; // 50px width + 3px spacing
              const scrollPosition = currentSlotIndex * slotWidth - 200;
              scrollContainerRef.current.scrollLeft = Math.max(
                0,
                scrollPosition,
              );
            }
          }
        }, 100);
      } catch (err) {
        console.error("Error fetching Amber data:", err);
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [systemId]);

  if (loading) {
    return (
      <div className="w-full p-4 md:p-6 bg-gray-900/50 border border-gray-700 rounded-lg">
        <h2 className="text-lg font-bold text-white mb-4">
          AMBER ELECTRIC - 48 HOUR TIMELINE
        </h2>
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full p-4 md:p-6 bg-gray-900/50 border border-gray-700 rounded-lg">
        <h2 className="text-lg font-bold text-white mb-4">
          AMBER ELECTRIC - 48 HOUR TIMELINE
        </h2>
        <div className="text-red-400">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="w-full p-4 md:p-6 bg-gray-900/50 border border-yellow-700 rounded-lg">
      <h2 className="text-lg font-bold text-white mb-4">
        AMBER ELECTRIC - 48 HOUR TIMELINE
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
                // Subtract 30 minutes to show period start instead of period end
                const periodStart = new Date(
                  slot.time.getTime() - 30 * 60 * 1000,
                );
                const localTime = new Date(
                  periodStart.getTime() + timezoneOffsetMin * 60 * 1000,
                );

                // Check if this is midnight in system's local time
                // Note: localTime has timezone offset baked in, so use format to extract hour
                const timeStr = format(localTime, "HH:mm");
                const isMidnight = timeStr === "00:00";

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
                        {format(localTime, "d MMM")}
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

                // Subtract 30 minutes to show period start instead of period end
                const periodStart = new Date(
                  slot.time.getTime() - 30 * 60 * 1000,
                );

                // Convert to system's local time
                const localTime = new Date(
                  periodStart.getTime() + timezoneOffsetMin * 60 * 1000,
                );

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
                        {format(localTime, "HH:mm")}
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
