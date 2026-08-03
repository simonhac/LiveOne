/**
 * Sparkline geometry — the honest-extent rules for the tiny inline sparklines.
 *
 * A sparkline has no axes, so the only thing telling a reader "this is up to date" is that the line
 * reaches the right-hand edge. That makes two mistakes indistinguishable from healthy data:
 *
 *  1. **Dropping nulls before measuring length.** A dense window with a null tail (routine here — the
 *     history payload is a dense 5-minute grid over `[now − 24h, now]`, and the newest intervals are
 *     null until the producer catches up) becomes a shorter array, which then gets stretched across
 *     the full width. The last real sample lands on the right edge and the gap vanishes.
 *  2. **Bridging a gap.** A line drawn straight across missing readings asserts data that was never
 *     taken — the same reason `lib/charts/svg/paths.ts` breaks on `.defined()` rather than spanning.
 *
 * So: x comes from the position in the FULL array (nulls included), never from the count of drawable
 * values, and the polyline breaks at every gap. A series that stops short leaves visible empty space
 * on the right, which is the whole point.
 */

/** A run of consecutive drawable points, as an SVG `points` string. */
export type SparklineSegment = string;

export interface SparklineGeometry {
  /** One entry per contiguous run of non-null values; empty when nothing is drawable. */
  segments: SparklineSegment[];
  /** Value range the y-axis was scaled to (null when nothing is drawable). */
  domain: { min: number; max: number } | null;
  /** Count of drawable values — callers use this to decide whether to render at all. */
  drawable: number;
}

/**
 * Lay `values` out over a `w`×`h` box. Index `i` maps to `x = i / (values.length - 1) * w`, so the
 * x-axis is the requested window regardless of how many values are present; `y` is scaled to the
 * min/max of the drawable values (a flat series pins to the bottom rather than dividing by zero).
 *
 * Anything that is not a finite number — null, undefined, NaN, a string from a `quality` field — is a
 * gap. A single isolated point produces no segment: a polyline needs two vertices, and a lone dot
 * would read as a full-width line once stroked.
 */
export function sparklineGeometry(
  values: readonly (number | null | undefined)[],
  w: number,
  h: number,
): SparklineGeometry {
  const drawableAt = values.map(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  const drawable = drawableAt.filter(Boolean).length;
  if (drawable === 0) return { segments: [], domain: null, drawable: 0 };

  const present = values.filter(
    (v, i) => drawableAt[i] && v != null,
  ) as number[];
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;

  // Denominator is the FULL array — see the module header. A one-element array would divide by zero,
  // and it can't produce a segment anyway, so it falls out with `drawable < 2` below.
  const lastIndex = values.length - 1;
  if (lastIndex < 1) return { segments: [], domain: { min, max }, drawable };

  const segments: SparklineSegment[] = [];
  let run: string[] = [];
  const flush = () => {
    // Two vertices minimum: `<polyline>` renders nothing for one point, and with a round linecap it
    // would render a dot the reader has no way to interpret.
    if (run.length >= 2) segments.push(run.join(" "));
    run = [];
  };

  for (let i = 0; i <= lastIndex; i++) {
    if (!drawableAt[i]) {
      flush();
      continue;
    }
    const x = (i / lastIndex) * w;
    const y = h - (((values[i] as number) - min) / span) * h;
    run.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  flush();

  return { segments, domain: { min, max }, drawable };
}
