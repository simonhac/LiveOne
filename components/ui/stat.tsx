import React from "react";
import Value from "./value";

/**
 * A hero value with an optional caption beneath it — the shape used by the grid,
 * battery-contents and provenance cards. Folds together what used to be four
 * copy-pasted `Stat` components with drifting defaults.
 */
export default function Stat({
  value,
  prefix,
  unit,
  qualifier,
  caption,
  valueClassName,
}: {
  value: React.ReactNode;
  prefix?: string;
  unit?: string;
  qualifier?: string;
  caption?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div>
      <p
        className={`text-xl font-bold leading-none md:text-2xl ${
          valueClassName ?? "text-gray-100"
        }`}
      >
        <Value
          value={value}
          prefix={prefix}
          unit={unit}
          qualifier={qualifier}
        />
      </p>
      {caption && (
        <p className="mt-1 text-[10px] uppercase tracking-wide text-gray-500 md:text-xs">
          {caption}
        </p>
      )}
    </div>
  );
}
