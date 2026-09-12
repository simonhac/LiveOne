import { z } from "zod";

// A caller supplies the same fixed cutoff on every page. UTC only: SQL uses UTC timestamps.
const timestamp = z
  .string()
  .datetime()
  .refine((s) => Number.isFinite(Date.parse(s)));
export const referenceQuery = z
  .object({
    pollerId: z.string().uuid(),
    revision: z.coerce.number().int().positive(),
    pointId: z.string().uuid(),
    start: timestamp,
    end: timestamp,
    asOf: timestamp,
    cursor: timestamp.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(500),
  })
  .strict()
  .superRefine((q, ctx) => {
    const start = Date.parse(q.start),
      end = Date.parse(q.end),
      cutoff = Date.parse(q.asOf);
    if (
      end <= start ||
      end - start > 3600000 ||
      cutoff < end ||
      cutoff > Date.now() ||
      (q.cursor &&
        (Date.parse(q.cursor) < start || Date.parse(q.cursor) >= end))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Use a completed window of at most one hour, a fixed past cutoff, and an in-window cursor",
      });
    }
  });

export function referencePage<T extends { timestamp: string }>(
  rows: T[],
  limit: number,
) {
  const readings = rows.slice(0, limit);
  return {
    readings,
    nextCursor:
      rows.length > limit ? readings[readings.length - 1].timestamp : null,
  };
}
