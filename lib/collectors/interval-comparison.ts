import { z } from "zod";

const sample = z.object({
  timestamp: z.string().datetime(),
  receivedTime: z.string().datetime().optional(),
  value: z.number().finite().nullable(),
  sessionId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  dataQuality: z.string().optional(),
});
const series = z.object({
  deviceId: z.string().min(1),
  physicalPath: z.string().min(1),
  metricType: z.enum(["power", "soc", "energy"]),
  unit: z.string(),
  transform: z.enum(["n", "i", "d"]).nullable(),
  cadenceMs: z.number().int().positive(),
  samples: z.array(sample),
});
export const comparisonInput = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  windowMs: z.number().int().positive(),
  minimumCoverage: z.number().positive().max(1),
  absoluteTolerance: z.number().finite().nonnegative(),
  relativeTolerance: z.number().finite().nonnegative(),
  reference: series,
  trial: series,
});
type Series = z.infer<typeof series>;
type Sample = z.infer<typeof sample> & { time: number };

function summarize(s: Series, start: number, end: number) {
  const all: Sample[] = s.samples
    .map((p) => ({ ...p, time: Date.parse(p.timestamp) }))
    .sort((a, b) => a.time - b.time);
  const rows = all.filter((p) => p.time >= start && p.time < end);
  const unique = new Map<number, Sample>();
  let duplicates = 0;
  // Exact repeated timestamps are ambiguous evidence, even when values match.
  for (const p of all) {
    if (unique.has(p.time) && p.time >= start && p.time <= end) duplicates++;
    unique.set(p.time, p);
  }
  const valid = [...unique.values()].filter(
    (p) =>
      p.value !== null &&
      !p.error &&
      (!p.dataQuality || p.dataQuality === "good"),
  );
  const slots = new Map<number, number[]>();
  for (const p of valid.filter((p) => p.time >= start && p.time < end)) {
    const slot = Math.floor((p.time - start) / s.cadenceMs);
    slots.set(slot, [...(slots.get(slot) ?? []), p.value!]);
  }
  const expected = (end - start) / s.cadenceMs;
  const coverage = slots.size / expected;
  const times = valid
    .filter((p) => p.time >= start && p.time < end)
    .map((p) => p.time);
  const boundaries = [start, ...times, end];
  const maximumGapMs = Math.max(
    ...boundaries.slice(1).map((t, i) => t - boundaries[i]),
  );
  const lags = rows
    .filter((p) => p.receivedTime)
    .map((p) => Date.parse(p.receivedTime!) - p.time);
  let value: number | null = null;
  let reset = false;
  if (s.metricType === "energy") {
    // Cumulative counters only. Interpolate common boundaries only across one cadence;
    // no extrapolation of the startup baseline and no bridging missing intervals.
    const at = (t: number) => {
      const exact = valid.find((p) => p.time === t);
      if (exact) return exact.value;
      const before = valid.filter((p) => p.time < t).at(-1);
      const after = valid.find((p) => p.time > t);
      if (
        !before ||
        !after ||
        after.time - before.time > s.cadenceMs * 1.5 ||
        before.sessionId !== after.sessionId ||
        after.value! < before.value!
      )
        return null;
      return (
        before.value! +
        ((after.value! - before.value!) * (t - before.time)) /
          (after.time - before.time)
      );
    };
    const before = valid.filter((p) => p.time <= start).at(-1);
    const after = valid.find((p) => p.time >= end);
    const relevant = valid.filter(
      (p) =>
        p.time >= (before?.time ?? start) && p.time <= (after?.time ?? end),
    );
    reset = relevant.some(
      (p, i) =>
        i > 0 &&
        (p.value! < relevant[i - 1].value! ||
          p.sessionId !== relevant[i - 1].sessionId),
    );
    const first = at(start),
      last = at(end);
    if (!reset && first !== null && last !== null) value = last - first;
  } else if (slots.size) {
    // Equal-weight cadence slots prevent a burst from dominating the window mean.
    const means = [...slots.values()].map(
      (values) => values.reduce((a, b) => a + b, 0) / values.length,
    );
    value = means.reduce((a, b) => a + b, 0) / means.length;
    if (s.transform === "i") value = -value;
  }
  return {
    expected,
    observed: rows.length,
    coverage,
    duplicates,
    maximumGapMs,
    maximumArrivalLagMs: lags.length ? Math.max(...lags) : null,
    reset,
    value,
  };
}

/** Offline evidence only: this report never activates a collector. */
export function compareIntervals(input: unknown) {
  const q = comparisonInput.parse(input);
  const start = Date.parse(q.start),
    end = Date.parse(q.end);
  if (
    end <= start ||
    end - start > 86400000 ||
    start % q.windowMs ||
    end % q.windowMs ||
    q.windowMs % q.reference.cadenceMs ||
    q.windowMs % q.trial.cadenceMs
  ) {
    throw new Error(
      "Use complete UTC-aligned windows (at most one day) divisible by both cadences",
    );
  }
  const a = q.reference,
    b = q.trial;
  if (
    a.metricType !== b.metricType ||
    a.unit !== b.unit ||
    a.unit !== { power: "W", soc: "%", energy: "Wh" }[a.metricType]
  ) {
    throw new Error(
      "Metric/unit mismatch; convert explicitly before comparison",
    );
  }
  if (
    a.transform !== b.transform ||
    (a.metricType === "energy" ? a.transform !== "d" : a.transform === "d")
  ) {
    throw new Error("Transform mismatch or unsupported energy semantics");
  }
  const windows = [];
  for (let time = start; time < end; time += q.windowMs) {
    const reference = summarize(a, time, time + q.windowMs);
    const trial = summarize(b, time, time + q.windowMs);
    const eligible = [reference, trial].every(
      (s) =>
        s.coverage >= q.minimumCoverage &&
        s.duplicates === 0 &&
        !s.reset &&
        s.value !== null,
    );
    const difference =
      reference.value !== null && trial.value !== null
        ? trial.value - reference.value
        : null;
    const tolerance =
      reference.value === null
        ? null
        : q.absoluteTolerance + q.relativeTolerance * Math.abs(reference.value);
    windows.push({
      start: new Date(time).toISOString(),
      end: new Date(time + q.windowMs).toISOString(),
      reference,
      trial,
      difference,
      tolerance,
      status: !eligible
        ? "insufficient-evidence"
        : Math.abs(difference!) <= tolerance!
          ? "pass"
          : "difference",
    });
  }
  return {
    version: 1,
    mapping: {
      reference: { ...a, samples: undefined },
      trial: { ...b, samples: undefined },
    },
    policy: {
      windowMs: q.windowMs,
      minimumCoverage: q.minimumCoverage,
      absoluteTolerance: q.absoluteTolerance,
      relativeTolerance: q.relativeTolerance,
    },
    windows,
    passed: windows.every((w) => w.status === "pass"),
  };
}
