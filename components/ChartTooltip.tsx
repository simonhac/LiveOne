import React from "react";
import Value from "@/components/ui/value";

interface ChartTooltipProps {
  solar: number | null;
  load: number | null;
  battery?: number | null;
  grid?: number | null;
  batterySOC: number | null;
  unit: "kW" | "kWh";
  visible: boolean;
}

export default function ChartTooltip({
  solar,
  load,
  battery,
  grid,
  batterySOC,
  unit,
  visible,
}: ChartTooltipProps) {
  return (
    <div className="flex items-center gap-3 sm:gap-6 md:gap-10 text-xs">
      {/* Solar */}
      <div className="flex items-center gap-1">
        <span className="w-3 h-3 bg-yellow-400"></span>
        <span className="text-gray-400">Solar</span>
        <span
          style={{
            minWidth: "48px",
            display: "inline-flex",
            fontFamily: "DM Sans, system-ui, sans-serif",
            justifyContent: "flex-end",
          }}
        >
          {solar !== null && solar !== undefined ? (
            <Value
              className="text-white"
              value={solar.toFixed(1)}
              unit={unit}
            />
          ) : null}
        </span>
      </div>

      {/* Load */}
      <div className="flex items-center gap-1">
        <span className="w-3 h-3 bg-blue-400"></span>
        <span className="text-gray-400">Load</span>
        <span
          style={{
            minWidth: "48px",
            display: "inline-flex",
            fontFamily: "DM Sans, system-ui, sans-serif",
            justifyContent: "flex-end",
          }}
        >
          {load !== null && load !== undefined ? (
            <Value className="text-white" value={load.toFixed(1)} unit={unit} />
          ) : null}
        </span>
      </div>

      {/* Battery Power - only show if battery data is available */}
      {battery !== null && battery !== undefined && (
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 bg-orange-400"></span>
          <span className="text-gray-400">Battery</span>
          <span
            style={{
              minWidth: "48px",
              display: "inline-flex",
              fontFamily: "DM Sans, system-ui, sans-serif",
              justifyContent: "flex-end",
            }}
          >
            <Value
              className="text-white"
              value={battery.toFixed(1)}
              unit={unit}
            />
          </span>
        </div>
      )}

      {/* Grid - only show if grid data is available */}
      {grid !== null && grid !== undefined && (
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 bg-red-500"></span>
          <span className="text-gray-400">Grid</span>
          <span
            style={{
              minWidth: "48px",
              display: "inline-flex",
              fontFamily: "DM Sans, system-ui, sans-serif",
              justifyContent: "flex-end",
            }}
          >
            <Value className="text-white" value={grid.toFixed(1)} unit={unit} />
          </span>
        </div>
      )}

      {/* Battery SOC */}
      <div className="flex items-center gap-1">
        <span className="w-3 h-3 bg-green-400"></span>
        <span className="text-gray-400">Battery</span>
        <span
          style={{
            minWidth: "48px",
            display: "inline-flex",
            fontFamily: "DM Sans, system-ui, sans-serif",
            justifyContent: "flex-end",
          }}
        >
          {batterySOC !== null && batterySOC !== undefined ? (
            <Value
              className="text-white"
              value={batterySOC.toFixed(1)}
              unit={"%"}
            />
          ) : null}
        </span>
      </div>
    </div>
  );
}
