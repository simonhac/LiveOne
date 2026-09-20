/**
 * A tile's mini bar chart — the Activity app's Step Count card (docs/architecture/tile-style.md,
 * rule 8): thin round-capped bars in the series colour, a faint hairline per slot, a stronger one
 * where a time label starts. No axes, no gridlines, no tooltip.
 *
 * Bars come pre-bucketed (`bucketBars` in lib/charts/tile-bars.ts). They are scaled to the largest
 * bar in view; negative values clamp to the baseline.
 */
import type { TileBar } from "@/lib/charts/tile-bars";
import { TILE_TICK } from "@/lib/tile-style";

/**
 * The bars' own footprint, held open while the period's data is in flight. Same box as the real
 * thing — the plot area plus the tick-label row — because the bars arrive on a SEPARATE fetch from
 * the tile's live value, so without this the tile grows under the reader the moment it lands, and
 * every tile below it moves. Deliberately empty rather than a shimmer: it is a fraction of a second
 * on a warm cache, and a pulsing block in every tile would be the loudest thing on the page.
 */
export function MiniBarsSkeleton({ className }: { className?: string }) {
  return (
    <div className="mt-auto w-full" aria-hidden data-skeleton="">
      <div className={`w-full ${className ?? "h-10"}`} />
      <div className="h-3.5 w-full" />
    </div>
  );
}

export default function MiniBars({
  bars,
  color,
  className,
  ariaLabel,
}: {
  bars: readonly TileBar[];
  /** The series colour, as an `rgb()` literal. */
  color: string;
  /** Sizes the plot area (the labels sit below it) — e.g. `h-10`. */
  className?: string;
  ariaLabel?: string;
}) {
  if (bars.length === 0 || bars.every((b) => b.value == null)) return null;
  const max = Math.max(0, ...bars.map((b) => b.value ?? 0)) || 1;
  const hasTicks = bars.some((b) => b.tick);

  return (
    // `mt-auto`: in a tile's flex-column body the bars sit on the bottom edge, like the Activity
    // card's, whatever height the row gives the tile.
    <div role="img" aria-label={ariaLabel} className="mt-auto w-full">
      <div className={`flex w-full items-stretch ${className ?? "h-10"}`}>
        {bars.map((bar, i) => {
          const fraction = Math.max(0, bar.value ?? 0) / max;
          return (
            <div
              key={i}
              className={`relative flex-1 border-l ${
                bar.tick ? "border-line-hairline" : "border-line-faint"
              }`}
            >
              {bar.value != null && bar.value > 0 && (
                <div
                  className="tile-ease absolute bottom-0 left-1/2 w-[max(2px,34%)] max-w-[4px] -translate-x-1/2 rounded-full"
                  style={{
                    // A 2px floor so a non-zero bucket is a visible dot, never nothing.
                    height: `max(2px, ${(fraction * 100).toFixed(1)}%)`,
                    backgroundColor: color,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      {hasTicks && (
        // Labels sit to the RIGHT of their hairline, which runs on down into this row.
        <div className="flex w-full">
          {bars.map((bar, i) => (
            <div
              key={i}
              className={`relative h-3.5 flex-1 ${bar.tick ? "border-l border-line-hairline" : ""}`}
            >
              {bar.tick && (
                <span
                  className={`absolute left-[3px] top-px whitespace-nowrap ${TILE_TICK}`}
                >
                  {bar.tick}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
