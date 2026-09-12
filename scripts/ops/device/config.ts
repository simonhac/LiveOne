/**
 * `liveone device config` — read, audit and normalise a device's stored `DeviceConfig` blob.
 *
 * ## Why this exists
 *
 * `devices.config` is jsonb, and `parseDeviceConfig` is a WHITELIST REBUILD: it copies across only
 * the keys it names, and the PATCH that calls it REPLACES the column. So the moment a config key is
 * deleted from the code, every stored copy of it becomes unreachable rot that nothing sweeps —
 * invisible to `tsc`, invisible to the UI, and still sitting in prod.
 *
 * That is not a hypothetical. #481 deleted `exportTariff` from the type, the parser, the resolvers
 * and the docs, shipped 34 files, and swept exactly zero rows; Kinkora Mondo still stored
 * `{"batteryProvenance":{"exportTariff":{"mode":"amber"}}}` weeks later. CLAUDE.md's rule — "a rename
 * is only half a change when documents persist the old name" — is written around `dashboards.doc`,
 * which HAS a sweeper (`scripts/utils/migrate-card-type.ts`). `devices.config` had none.
 *
 * ## The three verbs
 *
 *   show    the stored blob, verbatim — what is actually in the column
 *   lint    what the current parser WOULD drop, per device. Read-only, and the standing guard:
 *           run it after any config-shape change and it names every device that no longer
 *           round-trips. This is the check that would have caught #481.
 *   clean   re-parse and write the normalised form back, evicting whatever `lint` named.
 *
 * `lint` needs no server support at all — `GET /api/v4/devices/{id}` already returns `config` as-is
 * and is already CLI-reachable — so the audit works against any deployment, including one that
 * predates the write route.
 *
 * 🛑 `clean` is LOSSY BY DESIGN: dropping keys is the whole point. It is dry-run by default and the
 * dry run prints every path it would drop WITH its stored value, so what is being discarded is on
 * screen before `--apply` is typed. There is no undo — `devices.config` has no revision history
 * (unlike `dashboards`, which has `dashboard_revisions`).
 */
import { EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import {
  parseDeviceConfig,
  droppedConfigPaths,
} from "@/lib/capabilities/parse-config";
import {
  BASE_URL_FLAG,
  listDevices,
  resolveDevice,
  str,
  bool,
  usage,
  type WireDevice,
} from "../shared";

const DEVICE_ARG = {
  name: "device",
  required: false,
  help: "A device: its dv_… id, integer handle, slug, or name (omit only with --all)",
} as const;

const ALL_FLAG = {
  all: {
    type: "boolean",
    help: "Every device you can read, instead of one named device",
  },
} as const;

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export const configSpec = {
  name: "config",
  summary:
    "The stored DeviceConfig blob — read it, audit it for rot, normalise it.",
  when:
    "Reach for this when a config key has been DELETED from the code and you need the stored copies\n" +
    "swept, or after any change to the config shape, to prove nothing stale is left behind.\n" +
    "To CHANGE a setting, use the device configurator in the web app — these verbs normalise, they\n" +
    "do not edit.",
  description:
    "`devices.config` is a whitelist-parsed jsonb blob: a key the parser no longer names is dropped\n" +
    "on the next save, so a deleted config key leaves rot in every stored copy until something\n" +
    "rewrites them. `lint` finds that rot and `clean` evicts it, by round-tripping the blob through\n" +
    "the current parser.\n" +
    "\n" +
    "`batteryProvenance` is MIRRORED into `areas.config` for every area where this device is the\n" +
    "preferred battery/power binding, so the same rot sits in two places. `clean` fixes both and\n" +
    "names the areas it touched — the mirror's resolution is hand-written SQL whose failure mode is\n" +
    "silent under-resolution, so it reports rather than assumes.",
  subcommands: {
    show: {
      name: "show",
      summary: "The device's stored config blob, verbatim.",
      when: "Use this to see exactly what is in the column, including keys the code no longer knows.",
      args: [{ ...DEVICE_ARG, required: true }],
      flags: { ...BASE_URL_FLAG },
      examples: [
        "liveone device config show kinkora-mondo",
        "liveone device config show 6 --format json",
      ],
    },
    lint: {
      name: "lint",
      summary: "What the current parser would DROP from the stored config.",
      when:
        "Run this after deleting or renaming a config key, and after any change to `DeviceConfig`.\n" +
        "A clean result is the evidence that a code-side deletion was also a data-side one.",
      description:
        "Reports, per device: the dotted paths a save would drop, and their stored values. Also\n" +
        "reports a stored blob the parser REJECTS — that is a different finding (something to fix,\n" +
        "not something to drop) and it does not stop the sweep.\n" +
        "\n" +
        "Read-only, and it needs nothing of the server beyond the device aggregate, so it works\n" +
        "against any deployment. Exit 1 when anything was found.",
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG, ...ALL_FLAG },
      exitCodes: {
        1: "at least one device has config the parser would drop or reject",
      },
      examples: [
        "liveone device config lint --all",
        "liveone device config lint --all --format json",
        "liveone device config lint kinkora-mondo",
      ],
    },
    clean: {
      name: "clean",
      summary: "Re-parse the stored config and write back the normalised form.",
      when:
        "Use this to evict what `lint` named. Run `lint` first — this verb's dry run shows the same\n" +
        "thing, but per device rather than across the fleet.",
      description:
        "🛑 LOSSY BY DESIGN, and there is no undo: `devices.config` has no revision history. The dry\n" +
        "run prints every path it would drop WITH its stored value; nothing is written without\n" +
        "--apply.\n" +
        "\n" +
        "A device whose config the parser REJECTS is reported and SKIPPED, never written — a\n" +
        "rejection means the stored blob is malformed in a way the parser will not silently repair,\n" +
        "and writing the parse of something that did not parse is how data gets lost.\n" +
        "\n" +
        "Also rewrites the `areas.config` mirror of `batteryProvenance`, and names the areas.",
      mutates: true,
      args: [DEVICE_ARG],
      flags: { ...BASE_URL_FLAG, ...ALL_FLAG },
      exitCodes: {
        1: "a device was skipped because its stored config does not parse",
      },
      examples: [
        "liveone device config clean kinkora-mondo",
        "liveone device config clean kinkora-mondo --apply",
        "liveone device config clean --all --apply",
      ],
    },
  },
} satisfies CommandSpec;

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/** One device's stored config, as `GET /api/v4/devices/{id}` returns it. */
async function fetchConfig(
  s: ApiSession,
  device: WireDevice,
): Promise<unknown> {
  const body = await s.get<{ device?: { config?: unknown }; config?: unknown }>(
    `/api/v4/devices/${device.id}`,
  );
  // The aggregate nests it under `device`; the config address returns it flat. Accept both so this
  // helper does not care which one it was handed.
  return body.device?.config ?? body.config ?? null;
}

/** What `lint`/`clean` concluded about one device. */
interface Audit {
  device: WireDevice;
  stored: unknown;
  /** Dotted paths a save would drop, with the value that would go. */
  drops: { path: string; value: unknown }[];
  /** Set when the parser REFUSES the stored blob — a finding, but not a drop. */
  rejected: string | null;
  /** The normalised blob `clean` would write. Null when `rejected`. */
  cleaned: unknown;
}

function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function audit(device: WireDevice, stored: unknown): Audit {
  // An absent config has nothing to say. `{}` is treated the same — the parser collapses it to null
  // and there is no rot in an empty object.
  if (stored === null || stored === undefined)
    return { device, stored, drops: [], rejected: null, cleaned: null };

  const parsed = parseDeviceConfig(stored);
  if ("error" in parsed)
    return {
      device,
      stored,
      drops: [],
      rejected: parsed.error,
      cleaned: null,
    };

  const drops = droppedConfigPaths(stored).map((path) => ({
    path,
    value: valueAt(stored, path),
  }));
  return { device, stored, drops, rejected: null, cleaned: parsed.config };
}

/**
 * The subject set: exactly one named device, or every readable one under --all.
 *
 * 🛑 `--all` is explicit and has no default — `device recompute`'s rule, for its reason: a verb whose
 * broad case is the one you get by typing LESS will eventually be typed less.
 */
async function subjects(s: ApiSession, ctx: Ctx): Promise<WireDevice[]> {
  const ref = ctx.args[0];
  const all = bool(ctx, "all");
  if (ref && all)
    throw usage(
      "a device and --all",
      "--all means every device, so naming one as well is contradictory",
      "drop --all to work on that device, or drop the argument to sweep",
    );
  if (!ref && !all)
    throw usage(
      "no device named",
      "this verb needs a subject, and there is deliberately no 'absent means everything'",
      "name a device, or pass --all to sweep every device you can read",
    );
  if (all) return listDevices(s);
  return [await resolveDevice(s, ref)];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const ref = ctx.args[0];
    if (!ref)
      throw usage(
        "no device named",
        "`config show` reads one device",
        "name a device — `liveone device list` shows them",
      );
    const device = await resolveDevice(s, ref);
    const stored = await fetchConfig(s, device);
    ctx.emit(
      {
        device: {
          id: device.id,
          systemId: device.legacySystemId,
          name: device.name,
        },
        config: stored,
      },
      () =>
        [
          `${device.name} (${device.id})`,
          stored === null || stored === undefined
            ? "  (no config stored)"
            : JSON.stringify(stored, null, 2)
                .split("\n")
                .map((l) => `  ${l}`)
                .join("\n"),
        ].join("\n"),
    );
    return EXIT.OK;
  });
}

function renderAudits(audits: Audit[], verb: "lint" | "clean"): string {
  const interesting = audits.filter(
    (a) => a.drops.length > 0 || a.rejected !== null,
  );
  if (interesting.length === 0)
    return `${audits.length} device(s) checked — every stored config round-trips cleanly.`;

  const lines: string[] = [];
  for (const a of interesting) {
    lines.push(`${a.device.name} (${a.device.id})`);
    if (a.rejected) {
      lines.push(`  🛑 the stored config does NOT parse: ${a.rejected}`);
      lines.push(
        verb === "clean"
          ? "     skipped — nothing written. Fix the stored blob, then re-run."
          : "     this is something to FIX, not something to drop.",
      );
    }
    for (const d of a.drops)
      lines.push(`  - ${d.path} = ${JSON.stringify(d.value)}`);
  }
  lines.push(
    "",
    `${interesting.length} of ${audits.length} device(s) have config the parser would not carry through.`,
  );
  return lines.join("\n");
}

async function runLint(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const devices = await subjects(s, ctx);
    const audits: Audit[] = [];
    for (const d of devices) audits.push(audit(d, await fetchConfig(s, d)));

    const findings = audits.filter(
      (a) => a.drops.length > 0 || a.rejected !== null,
    );
    ctx.emit(
      {
        checked: audits.length,
        findings: findings.map((a) => ({
          deviceId: a.device.id,
          systemId: a.device.legacySystemId,
          name: a.device.name,
          drops: a.drops,
          rejected: a.rejected,
        })),
      },
      () => renderAudits(audits, "lint"),
    );
    return findings.length ? EXIT.FINDINGS : EXIT.OK;
  });
}

async function runClean(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const devices = await subjects(s, ctx);
      const audits: Audit[] = [];
      for (const d of devices) audits.push(audit(d, await fetchConfig(s, d)));

      // Only devices with something to drop are written. A device whose config already round-trips
      // would be written back byte-identical — a pointless UPDATE that bumps `updated_at` and makes
      // the report claim work that did nothing.
      const targets = audits.filter((a) => a.drops.length > 0 && !a.rejected);
      const skipped = audits.filter((a) => a.rejected !== null);

      const written: {
        deviceId: string | null;
        name: string;
        areas: { id: string; name: string }[];
      }[] = [];
      if (!ctx.dryRun) {
        for (const a of targets) {
          const body = await apiFetch<{
            areas?: { id: string; name: string }[];
          }>(s.origin, `/api/v4/devices/${a.device.id}/config`, {
            method: "PATCH",
            token: s.token,
            body: a.cleaned ?? {},
          });
          written.push({
            deviceId: a.device.id,
            name: a.device.name,
            areas: body.body.areas ?? [],
          });
        }
      }

      ctx.emit(
        {
          checked: audits.length,
          applied: !ctx.dryRun,
          targets: targets.map((a) => ({
            deviceId: a.device.id,
            systemId: a.device.legacySystemId,
            name: a.device.name,
            drops: a.drops,
            after: a.cleaned,
          })),
          skipped: skipped.map((a) => ({
            deviceId: a.device.id,
            name: a.device.name,
            rejected: a.rejected,
          })),
          written,
        },
        () => {
          const lines = [
            `${ctx.dryRun ? "would" : "WRITE"} clean ${targets.length} device config(s)`,
            "",
            renderAudits(audits, "clean"),
          ];
          if (written.length) {
            lines.push("");
            for (const w of written)
              lines.push(
                `wrote ${w.name}` +
                  (w.areas.length
                    ? ` — mirrored into ${w.areas.length} area(s): ${w.areas.map((x) => x.name).join(", ")}`
                    : " — no area mirrors this device's battery config"),
              );
          }
          if (ctx.dryRun && targets.length)
            lines.push("", "Re-run with --apply to write.");
          return lines.join("\n");
        },
      );
      // A skip is a finding: something was asked for and deliberately not done.
      return skipped.length ? EXIT.FINDINGS : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const CONFIG_HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  "config.show": runShow,
  "config.lint": runLint,
  "config.clean": runClean,
};
