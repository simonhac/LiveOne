/**
 * usher.yaml — the source config for a deployment. One file describes every source the usher runs;
 * the same file works on Fly (over WireGuard) or a Raspberry Pi (on-LAN) — only the device hosts and
 * whether a tunnel is needed differ. Secrets stay OUT of the file: `apiKeyEnv` names the env var /
 * secret that holds the device's `gk_` gusher key.
 *
 * Loaded + validated (zod) at startup. See core/factory.ts for how it becomes ScheduledEntry[].
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const InverterSchema = z.object({
  host: z.string(),
  /** master/slave; auto-detected (Site P_Load presence) when omitted */
  isMaster: z.boolean().optional(),
});

const DeepseaSourceSchema = z.object({
  type: z.literal("deepsea"),
  siteId: z.string(),
  apiKeyEnv: z.string(),
  host: z.string(),
  port: z.number().optional(),
  unitId: z.number().optional(),
  /**
   * Idle POLL period (s) — how often the run-loop reads the controller, and therefore the
   * diagnostic journal's cadence, since a journal record IS a read. Delivery to gusher is now a
   * SEPARATE cadence (`pushSec`); this key used to mean "push period" as well, back when the two
   * were welded together.
   */
  pollSec: z.number().positive().default(300),
  /** faster poll period (s) while the genset is running; defaults to pollSec (no speed-up) */
  activeSec: z.number().positive().optional(),
  /**
   * Idle PUSH period (s) — how often a poll is actually delivered to gusher. Defaults to `pollSec`,
   * i.e. deliver every poll, which is the historical behaviour and what every other deployment
   * still gets. Set it LONGER than `pollSec` to poll (and journal) at high resolution without
   * multiplying what LiveOne stores.
   */
  pushSec: z.number().positive().optional(),
  /** push period (s) while the genset is running; defaults to pushSec */
  activePushSec: z.number().positive().optional(),
});

const FroniusSourceSchema = z.object({
  type: z.literal("fronius"),
  siteId: z.string(),
  apiKeyEnv: z.string(),
  /** internal inverter poll (s) — the Site self-polls this fast; default 2 */
  invPollSec: z.number().positive().default(2),
  /** push cadence (s) — the run-loop harvests the minutely report; default 60 */
  pushSec: z.number().positive().default(60),
  inverters: z.array(InverterSchema).min(1),
});

export const SourceSchema = z.discriminatedUnion("type", [
  DeepseaSourceSchema,
  FroniusSourceSchema,
]);

export const UsherConfigSchema = z.object({
  /** the gusher receiver URL */
  gushEndpoint: z.string().default("http://localhost:3000/api/gush"),
  /**
   * Root of the on-disk store (blackbox/ journal + spool/ outage buffer). Default:
   * $USHER_DATA_DIR, else ./.usher-data. On Fly this points at the mounted volume (/data/usher);
   * without a writable dir the usher still runs — journaling/buffering just degrade with a warning.
   */
  dataDir: z.string().optional(),
  sources: z.array(SourceSchema).min(1),
});

export type UsherConfig = z.infer<typeof UsherConfigSchema>;
export type SourceConfig = z.infer<typeof SourceSchema>;
export type DeepseaSourceConfig = z.infer<typeof DeepseaSourceSchema>;
export type FroniusSourceConfig = z.infer<typeof FroniusSourceSchema>;

/** Default config path: $USHER_CONFIG, else ./usher.yaml relative to cwd. */
export function defaultConfigPath(): string {
  return process.env.USHER_CONFIG ?? "usher.yaml";
}

/** Read + parse + validate a usher.yaml. Throws (with a readable message) on missing file / bad schema. */
export function loadConfig(path: string = defaultConfigPath()): UsherConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `usher: cannot read config at ${path} (set USHER_CONFIG or add usher.yaml): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  const parsed = parseYaml(raw);
  const result = UsherConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `usher: invalid config at ${path}:\n${result.error.issues
        .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n")}`,
    );
  }
  return result.data;
}
