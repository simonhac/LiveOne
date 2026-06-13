"use client";

import { useQuery } from "@tanstack/react-query";

interface GeneratorEvent {
  date: string;
  startTime: string;
  endTime: string | null;
  running?: boolean;
  minPowerKw: number;
  maxPowerKw: number;
  energyKwh: number;
}

interface GeneratorData {
  events: GeneratorEvent[];
  totalEnergyKwh: number;
  running?: boolean;
}

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

  // Bounded read of persisted run periods (replaces the old unbounded generator-events scan).
  // A non-ok response yields null (rendered as "no events").
  const {
    data: generatorData,
    isPending,
    isError,
    error: queryError,
  } = useQuery<GeneratorData | null>({
    queryKey: ["system", propSystemId, "run-periods", "generator"],
    queryFn: async () => {
      const generatorResponse = await fetch(
        `/api/system/${propSystemId}/run-periods?role=generator&period=30d`,
        {
          credentials: "same-origin",
        },
      );

      if (generatorResponse.ok) {
        return (await generatorResponse.json()) as GeneratorData;
      }
      // Non-ok: original left generatorData null without surfacing an error.
      return null;
    },
    staleTime: 60_000,
    enabled: !!propSystemId,
  });

  const loading = isPending;
  const error = isError
    ? queryError instanceof Error
      ? queryError.message
      : "Unknown error"
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
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Generator Events</h1>

        {!generatorData || generatorData.events.length === 0 ? (
          <div className="text-gray-400">
            No generator runs found in the last 30 days
          </div>
        ) : (
          <>
            <div className="bg-gray-800 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-700">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Time
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium">
                      Generator Power
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium">
                      Energy (kWh)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {generatorData.events.map((event, idx) => (
                    <tr key={idx} className="hover:bg-gray-750">
                      <td className="px-4 py-3 text-sm">{event.date}</td>
                      <td className="px-4 py-3 text-sm">
                        {event.running
                          ? `${event.startTime} – now`
                          : event.endTime === null ||
                              event.startTime === event.endTime
                            ? event.startTime
                            : `${event.startTime} - ${event.endTime}`}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        {event.minPowerKw === event.maxPowerKw
                          ? `${event.minPowerKw.toFixed(1)} kW`
                          : `${event.minPowerKw.toFixed(1)} - ${event.maxPowerKw.toFixed(1)} kW`}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        {event.energyKwh.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-gray-700 font-bold">
                    <td className="px-4 py-3 text-sm" colSpan={3}>
                      Total
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      {generatorData.totalEnergyKwh.toFixed(2)} kWh
                    </td>
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
