/**
 * One row of the Activity app's Trends card: an optional chip, then a white label over a value in
 * the data's colour, with an optional caption after the value (a price beside an energy).
 * docs/architecture/tile-style.md.
 */
import type React from "react";
import { TILE_CAPTION, TILE_LABEL, TILE_VALUE_2 } from "@/lib/tile-style";

export default function TrendRow({
  chip,
  label,
  value,
  valueColor = "text-ink",
  caption,
  title,
}: {
  chip?: React.ReactNode;
  label: React.ReactNode;
  value: React.ReactNode;
  /** Tailwind text colour for the value — the series colour. */
  valueColor?: string;
  caption?: React.ReactNode;
  /** Native tooltip — the Home Energy ratios explain themselves on hover. */
  title?: string;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2 ${title ? "cursor-help" : ""}`}
      title={title}
    >
      {chip && <span className="shrink-0">{chip}</span>}
      <div className="min-w-0 flex-1">
        <p className={`truncate ${TILE_LABEL}`}>{label}</p>
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className={`${TILE_VALUE_2} ${valueColor} whitespace-nowrap`}>
            {value}
          </span>
          {caption != null && (
            <span className={`truncate ${TILE_CAPTION}`}>{caption}</span>
          )}
        </p>
      </div>
    </div>
  );
}
