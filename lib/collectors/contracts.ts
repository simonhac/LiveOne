import { z } from "zod";

const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.:[\]-]+$/);
export const settingsSchema = z
  .object({
    host: host.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    unitId: z.number().int().min(1).max(247).optional(),
    inverters: z
      .array(
        z.object({ host, master: z.boolean(), battery: z.boolean() }).strict(),
      )
      .max(16)
      .optional(),
    region: z.enum(["aus", "eu", "apac", "us", "cn"]).optional(),
    authMode: z.enum(["auto", "legacy", "openapi"]).optional(),
    pollMs: z.number().int().min(1000).max(3600000),
    pushMs: z.number().int().min(1000).max(3600000),
    activePollMs: z.number().int().min(1000).max(3600000).optional(),
    activePushMs: z.number().int().min(1000).max(3600000).optional(),
    postRunMs: z.number().int().min(0).max(86400000).optional(),
  })
  .strict();
export type PollerSettings = z.infer<typeof settingsSchema>;
export const sourceSchema = z.enum([
  "deepsea",
  "fronius",
  "selectronic",
  "sigenergy",
]);
export function validateSettings(source: string, settings: PollerSettings) {
  if (
    source === "deepsea" &&
    (!settings.host || !settings.port || !settings.unitId)
  )
    throw new Error("Deep Sea requires host, port and unit ID");
  if (
    source === "fronius" &&
    (settings.inverters?.filter((i) => i.master).length !== 1 ||
      settings.pollMs !== 2000)
  )
    throw new Error("Fronius requires one master and two-second sampling");
  if (source === "selectronic" && settings.pollMs < 60000)
    throw new Error("Selectronic requires at least one minute between reads");
  if (source === "sigenergy" && (!settings.region || settings.pollMs < 300000))
    throw new Error(
      "Sigenergy requires a region and at least five minutes between reads",
    );
}
const instant = z.string().datetime().nullable().optional();
export const statusSchema = z
  .object({
    id: z.string().uuid(),
    appliedRevision: z.number().int().min(0),
    collectionAt: instant,
    collectionStale: z.boolean().optional(),
    collectionError: z.enum(["collection-failed"]).optional(),
    deliveryError: z.enum(["delivery-failed"]).optional(),
    deliveryAt: instant,
    // Error codes only: vendor responses may contain credentials.
    error: z
      .enum([
        "",
        "config-rejected",
        "credential-unavailable",
        "collection-failed",
        "delivery-failed",
        "storage-failed",
        "reader-disabled",
        "supervision-pending",
      ])
      .optional(),
    stopped: z.boolean(),
    supervising: z.boolean(),
    storage: z
      .object({
        spoolBytes: z.number().nonnegative(),
        blackboxBytes: z.number().nonnegative(),
        dropped: z.number().int().nonnegative(),
        oldestPending: z.string().max(160).optional(),
        lostFirst: instant,
        lostLast: instant,
      })
      .strict()
      .optional(),
  })
  .strict();
export type PollerStatus = z.infer<typeof statusSchema>;
