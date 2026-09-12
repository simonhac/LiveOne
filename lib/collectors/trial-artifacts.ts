import { referenceQuery } from "./reference-export";
import { z } from "zod";
import { comparisonInput, compareIntervals } from "./interval-comparison";

const timestamp = z.string().datetime();
export const trialQuery = z
  .object({
    pollerId: z.string().uuid(),
    revision: z.number().int().positive(),
    vendorSiteId: z.string().min(1),
    start: timestamp,
    end: timestamp,
    asOf: timestamp,
  })
  .strict()
  .refine(
    (q) =>
      Date.parse(q.start) < Date.parse(q.end) &&
      Date.parse(q.end) - Date.parse(q.start) <= 3600000 &&
      Date.parse(q.end) <= Date.parse(q.asOf) &&
      Date.parse(q.asOf) <= Date.now(),
    "Use a completed window of at most one hour and a past cutoff",
  );
const reading = z.object({
  physicalPathTail: z.string(),
  metricType: z.string(),
  metricUnit: z.string(),
  transform: z.string().nullable().optional(),
  value: z.unknown(),
});
export const trialPage = z.object({
  asOf: timestamp,
  nextCursor: z.string(),
  batches: z
    .array(
      z.object({
        id: z.string().regex(/^[a-f0-9]{32}$/),
        pollerId: z.string().uuid(),
        revision: z.number().int().positive(),
        vendorSiteId: z.string(),
        action: z.literal("store"),
        sessionLabel: z.string(),
        measurementTime: timestamp,
        readings: z.array(reading),
      }),
    )
    .max(100),
});
const manifest = z.object({
  version: z.literal(1),
  pages: z.number().int().min(1).max(10000),
  pollerId: z.string().uuid(),
  revision: z.number().int().positive(),
  start: timestamp,
  end: timestamp,
  asOf: timestamp,
});
const referencePage = z.object({
  version: z.literal(1),
  deviceId: z.string().uuid(),
  pollerId: z.string().uuid(),
  revision: z.number(),
  start: timestamp,
  end: timestamp,
  asOf: timestamp,
  values: z.literal("raw-untransformed"),
  point: z.object({
    id: z.string().uuid(),
    physicalPath: z.string(),
    metricType: z.string(),
    unit: z.string(),
    transform: z.string().nullable(),
  }),
  readings: z.array(
    z.object({
      timestamp,
      receivedTime: timestamp,
      createdAt: timestamp,
      value: z.number().nullable(),
      error: z.string().nullable(),
      dataQuality: z.string(),
      sessionId: z.string().nullable(),
    }),
  ),
  nextCursor: timestamp.nullable(),
});
// A policy binds the reference identity and trial physical path explicitly. No name-based joins.
export const artifactPolicy = comparisonInput
  .omit({ reference: true, trial: true })
  .extend({
    pollerId: z.string().uuid(),
    revision: z.number().int().positive(),
    vendorSiteId: z.string().min(1),
    deviceId: z.string().uuid(),
    pointId: z.string().uuid(),
    referencePath: z.string().min(1),
    trialPath: z.string().min(1),
    metricType: z.enum(["power", "soc", "energy"]),
    unit: z.string(),
    transform: z.enum(["n", "i", "d"]).nullable(),
    referenceCadenceMs: z.number().int().positive(),
    trialCadenceMs: z.number().int().positive(),
  })
  .strict();

export function validateTrialPage(
  input: unknown,
  query: z.infer<typeof trialQuery>,
) {
  const page = trialPage.parse(input);
  if (Date.parse(page.asOf) !== Date.parse(query.asOf))
    throw new Error("Trial cutoff changed");
  for (const b of page.batches) {
    if (
      b.pollerId !== query.pollerId ||
      b.revision !== query.revision ||
      b.vendorSiteId !== query.vendorSiteId ||
      Date.parse(b.measurementTime) < Date.parse(query.start) ||
      Date.parse(b.measurementTime) >= Date.parse(query.end)
    ) {
      throw new Error("Trial batch outside assigned scope/window");
    }
  }
  if (
    page.nextCursor &&
    (!page.batches.length ||
      page.nextCursor !== `${page.batches.at(-1)!.id}.json`)
  ) {
    throw new Error("Invalid trial continuation cursor");
  }
  return page;
}

/** Assemble retained, complete exports without making network requests. */
export function assembleComparison(
  policyInput: unknown,
  reference: { complete: unknown; pages: unknown[] },
  trial: { complete: unknown; pages: unknown[] },
) {
  const policy = artifactPolicy.parse(policyInput);
  const refManifest = manifest
    .extend({ pointId: z.string().uuid() })
    .parse(reference.complete);
  const trialManifest = manifest
    .extend({ vendorSiteId: z.string() })
    .parse(trial.complete);
  referenceQuery.parse({
    pollerId: refManifest.pollerId,
    revision: refManifest.revision,
    pointId: refManifest.pointId,
    start: refManifest.start,
    end: refManifest.end,
    asOf: refManifest.asOf,
  });
  if (Date.parse(refManifest.asOf) !== Date.parse(trialManifest.asOf))
    throw new Error("Reference and trial cutoffs differ");
  for (const [m, pages] of [
    [refManifest, reference.pages],
    [trialManifest, trial.pages],
  ] as const) {
    if (
      m.pages !== pages.length ||
      m.pollerId !== policy.pollerId ||
      m.revision !== policy.revision ||
      Date.parse(m.start) > Date.parse(policy.start) ||
      Date.parse(m.end) < Date.parse(policy.end)
    )
      throw new Error("Incomplete or mismatched export manifest");
  }
  if (
    refManifest.pointId !== policy.pointId ||
    trialManifest.vendorSiteId !== policy.vendorSiteId
  )
    throw new Error("Export identity mismatch");
  const referenceSamples: z.infer<
    typeof comparisonInput
  >["reference"]["samples"] = [];
  let lastTimestamp = "";
  // ISO values retain microsecond precision when checking page order.
  const key = (s: string) => {
    const [seconds, fraction = ""] = s.replace(/Z$/, "").split(".");
    return `${seconds}.${fraction.padEnd(9, "0")}`;
  };
  reference.pages.forEach((raw, index) => {
    const page = referencePage.parse(raw);
    if (
      page.deviceId !== policy.deviceId ||
      page.pollerId !== policy.pollerId ||
      page.revision !== policy.revision ||
      page.point.id !== policy.pointId ||
      page.point.physicalPath !== policy.referencePath ||
      page.point.metricType !== policy.metricType ||
      page.point.unit !== policy.unit ||
      page.point.transform !== policy.transform ||
      page.start !== refManifest.start ||
      page.end !== refManifest.end ||
      page.asOf !== refManifest.asOf
    )
      throw new Error("Reference metadata mismatch");
    if (
      (index === reference.pages.length - 1) !== (page.nextCursor === null) ||
      (page.nextCursor !== null &&
        page.nextCursor !== page.readings.at(-1)?.timestamp)
    )
      throw new Error("Incomplete reference pagination");
    for (const row of page.readings) {
      if (
        (lastTimestamp && key(row.timestamp) <= key(lastTimestamp)) ||
        Date.parse(row.timestamp) < Date.parse(page.start) ||
        Date.parse(row.timestamp) >= Date.parse(page.end) ||
        Date.parse(row.createdAt) > Date.parse(page.asOf)
      )
        throw new Error("Reference row outside export bounds or order");
      lastTimestamp = row.timestamp;
      referenceSamples.push(row);
    }
  });
  const trialSamples: typeof referenceSamples = [];
  const { version: _version, pages: _pages, ...trialWindow } = trialManifest;
  const query = trialQuery.parse(trialWindow);
  let lastId = "";
  trial.pages.forEach((raw, index) => {
    const page = validateTrialPage(raw, query);
    if ((index === trial.pages.length - 1) !== (page.nextCursor === ""))
      throw new Error("Incomplete trial pagination");
    for (const batch of page.batches) {
      if (batch.id <= lastId)
        throw new Error("Duplicate or unordered trial batch");
      lastId = batch.id;
      const matches = batch.readings.filter(
        (r) => r.physicalPathTail === policy.trialPath,
      );
      if (matches.length > 1) throw new Error("Ambiguous trial physical path");
      const r = matches[0];
      if (
        r &&
        (r.metricType !== policy.metricType ||
          r.metricUnit !== policy.unit ||
          (r.transform ?? null) !== policy.transform ||
          (r.value !== null &&
            (typeof r.value !== "number" || !Number.isFinite(r.value))))
      )
        throw new Error("Trial value/unit/transform mismatch");
      trialSamples.push({
        timestamp: batch.measurementTime,
        value: r ? (r.value as number | null) : null,
        sessionId: batch.sessionLabel,
      });
    }
  });
  const common = {
    deviceId: policy.deviceId,
    metricType: policy.metricType,
    unit: policy.unit,
    transform: policy.transform,
  };
  const input = comparisonInput.parse({
    ...policy,
    reference: {
      ...common,
      physicalPath: policy.referencePath,
      cadenceMs: policy.referenceCadenceMs,
      samples: referenceSamples,
    },
    trial: {
      ...common,
      physicalPath: policy.trialPath,
      cadenceMs: policy.trialCadenceMs,
      samples: trialSamples,
    },
  });
  return { input, report: compareIntervals(input) };
}
