/**
 * The `derivation` domain of the `liveone` CLI — config that computes a new signal from existing
 * points (clean-sheet §4.4): run detectors, and the HWS thermal model.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * Http-only, and every verb speaks the v4 API: there is no `--via=db`, because everything that makes
 * a derivation correct is server-side. `ensureRunDetector` decides whether the area can host a
 * detector at all (a detector on a composite is invisible to the capability probe that lights its
 * card up — it refuses with `area-not-probed` and NAMES the member handles that would work), and the
 * recompute is a delete-and-reinsert under an advisory lock. A db leg would re-implement both to be
 * equally right, and would get the interesting cases wrong.
 *
 * ## Why this domain exists
 *
 * The run-tracking stack shipped with no CLI at all, so creating a detector meant either a seed
 * script with hand-copied point uuids or a raw `liveone api` POST — which is exactly how a detector
 * came to exist on dev and not on prod with nothing to notice the difference. Two ergonomics here
 * are the point rather than sugar:
 *
 *   - `--signal` takes a LOGICAL PATH (`load.ev/power`), resolved across the area's members. Pinning
 *     the wrong `pt_` id by hand is silent — you get a detector that simply never fires.
 *   - `recompute` has no unscoped form. It posts to `…/derivations/{dx_}/recompute`, where the scope
 *     is a path segment; the cron's optional-filter twin is what a full-range unscoped regenerate
 *     was reachable through, and it collapsed 71 dev rows to 3.
 */
import {
  defineCommand,
  EXIT,
  num,
  str,
  V,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { Point } from "@/lib/ids";
import { BASE_URL_FLAG, resolveRef, usage } from "../shared";

const AREA_ARG = {
  name: "area",
  required: true,
  help: "An area: its ar_… id, integer handle, or display name",
} as const;

const DERIVATION_ARG = {
  name: "derivation",
  required: true,
  help: "A derivation on that area: its dx_… id, its name, or its role",
} as const;

/** The two `derivations.kind` values this build knows. Mirrors lib/derivations/resolve.ts. */
const KINDS = ["run-detector", "hws-model"] as const;

/**
 * The roles a run detector can be configured for. Mirrors `TRACKABLE_ROLE_IDS`
 * (lib/roles/registry.ts, derived from `device.trackable`) — kept as a literal here for the same
 * reason `runsConfigSchema` keeps one: deriving the enum would drag the role registry into the
 * spec, which the CLI harness parses before it does anything else. Keep the two in step by hand;
 * the server validates the value regardless, so a stale list here refuses rather than misfires.
 */
const TRACKABLE_ROLES = ["generator", "ev"] as const;

/**
 * The threshold knobs, as `[CLI flag, params key]`. One table so `create` and `set` cannot disagree
 * about which flag writes which key — the sort of drift that is invisible until a detector is
 * configured through the verb that got it wrong.
 */
const KNOBS = [
  ["upper", "upperW"],
  ["lower", "lowerW"],
  ["hysteresis", "hysteresisW"],
  ["delayOn", "delayOnSeconds"],
  ["delayOff", "delayOffSeconds"],
] as const;

/** The knob flags, shared by `create` and `set`. */
const KNOB_FLAGS = {
  upper: {
    type: "number",
    placeholder: "W",
    help: "Above this, the device is ON",
  },
  lower: {
    type: "number",
    placeholder: "W",
    help: "Below this, the device is OFF",
  },
  hysteresis: {
    type: "number",
    placeholder: "W",
    help: "Deadband around the threshold",
  },
  delayOn: {
    type: "number",
    placeholder: "seconds",
    help: "Ignore an on-signal shorter than this",
  },
  delayOff: {
    type: "number",
    placeholder: "seconds",
    help: "Bridge a gap shorter than this. 🛑 Must comfortably EXCEED the point's sample interval, or every poll gap closes a run",
  },
} as const;

/** Read the knob flags that were actually passed, as `params` keys. Absent flags stay absent. */
function knobsFrom(ctx: Ctx): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [flag, key] of KNOBS) {
    const v = num(ctx, flag);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

interface WireArea {
  id: string | null;
  displayName: string;
  legacySystemId: number | null;
}

interface WireDerivation {
  id: string;
  kind: string;
  role: string | null;
  name: string;
  enabled: boolean;
  output: string;
  outputPointId: string | null;
  params: Record<string, unknown>;
  sourcePoints: Record<string, string | null>;
}

interface WirePoint {
  id: string;
  logicalPath: string | null;
  metricType: string;
  unit: string | null;
  name: string;
  active: boolean;
}

interface WireInterval {
  startTime: string;
  endTime: string | null;
  durationSeconds: number | null;
  energyKwh: number | null;
  avgSignal: number | null;
  maxSignal: number | null;
  signalUnit: string | null;
  costC: number | null;
  sampleCount: number;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** List + resolve, shared by every verb. The same two steps `liveone area` uses. */
async function resolveArea(s: ApiSession, ref: string): Promise<WireArea> {
  const { areas } = await s.get<{ areas: WireArea[] }>("/api/v4/areas");
  return resolveRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
    { noun: "area", listCmd: "liveone area list" },
  );
}

async function listDerivations(
  s: ApiSession,
  area: WireArea,
): Promise<WireDerivation[]> {
  const { derivations } = await s.get<{ derivations: WireDerivation[] }>(
    `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations`,
  );
  return derivations;
}

/**
 * Resolve `<derivation>` within an area: `dx_` id, else name, else ROLE.
 *
 * Role is the form an operator actually reaches for ("the ev one"), and `resolveRef` does not know
 * about it — so it is matched first, here, keeping `resolveRef`'s wording for both failure modes
 * rather than widening the shared helper with a field only this domain has.
 */
function resolveDerivation(
  rows: WireDerivation[],
  ref: string,
  area: WireArea,
): WireDerivation {
  const byRole = rows.filter((d) => d.role === ref);
  if (byRole.length === 1) return byRole[0];
  if (byRole.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${byRole.length} derivations on ${area.displayName}:\n${byRole.map((h) => `  ${h.id}  ${h.name}`).join("\n")}`,
      "address it by its dx_… id instead",
    );
  return resolveRef(rows, ref, {
    noun: "derivation",
    listCmd: `liveone derivation list ${area.id}`,
  });
}

/**
 * Resolve a `--signal`/`--energy` value to a `pt_` id: passed through if it already is one, else
 * matched as a LOGICAL PATH across the area's member devices.
 *
 * The path form is the one to use. A detector bound to the wrong point does not error — it just
 * never fires, or fires on the wrong thing, and the only symptom is an empty card weeks later. A
 * path (`load.ev/power`) says what you meant and is checked here against what the devices actually
 * publish; a hand-copied uuid says nothing and is checked against nothing.
 */
async function resolvePoint(
  s: ApiSession,
  area: WireArea,
  ref: string,
  flag: string,
): Promise<string> {
  if (Point.is(ref)) return ref;
  if (!ref.includes("/"))
    throw usage(
      `"${ref}" for --${flag}`,
      "expected a pt_… point id or a logical path",
      `a logical path looks like \`load.ev/power\` — run \`liveone area show ${area.id}\` for the members, then \`liveone device points <device>\``,
    );

  const { members } = await s.get<{ members: { id: string; name: string }[] }>(
    `/api/v4/areas/${encodeURIComponent(area.id!)}`,
  );
  const hits: { pointId: string; device: string; unit: string | null }[] = [];
  for (const m of members) {
    const { points = [] } = await s.get<{ points?: WirePoint[] }>(
      `/api/v4/devices/${encodeURIComponent(m.id)}?include=points`,
    );
    for (const p of points)
      if (p.logicalPath === ref)
        hits.push({ pointId: p.id, device: m.name, unit: p.unit });
  }

  if (hits.length === 0)
    throw usage(
      `no point on ${area.displayName} has the logical path "${ref}"`,
      "the detector would have nothing to follow",
      `run \`liveone device points <device>\` for the paths this site publishes`,
    );
  if (hits.length > 1)
    throw usage(
      `"${ref}" is ambiguous on ${area.displayName}`,
      `${hits.length} members publish it:\n${hits.map((h) => `  ${h.pointId}  ${h.device}`).join("\n")}`,
      "pass the pt_… id of the one you mean",
    );
  return hits[0].pointId;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const WINDOW_FLAGS = {
  last: {
    type: "string",
    placeholder: "30d",
    help: "Relative window ending now",
  },
  date: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "A single UTC day",
  },
  start: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "Window start (UTC)",
  },
  end: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "Window end, inclusive (UTC)",
  },
} as const;

export const derivationCommand = defineCommand({
  name: "derivation",
  summary:
    "Derived signals — run detectors and the HWS model: list, create, enable, recompute.",
  when:
    "Reach for this when a device's RUNS are the question — whether the generator/EV-charge detector\n" +
    "exists, what it has detected, or rebuilding its history after a config change. The `runs` card on\n" +
    "a dashboard shows what a detector here produced; `area` and `device` show the inputs it reads.",
  description:
    "Http-only: every verb calls the deployed v4 API as you (`liveone auth login`), and prints\n" +
    "`target: <origin> as <you>` on stderr first — read it to know which environment answered.\n" +
    "A derivation lives on an AREA, and must live on the area-of-one of the device it watches: a\n" +
    "detector on a composite is invisible to the capability probe, and `create` refuses with the\n" +
    "member handles that would work. Ids are per-environment.",
  uses: ["api"],
  subcommands: {
    list: {
      name: "list",
      summary: "The derivations on an area: id, kind, role, enabled, sources.",
      when: "Start here — to find a dx_… id, or to check whether a detector exists at all.",
      description:
        "There is no fleet-wide listing: the API serves derivations per area, so 'which detectors\n" +
        "exist anywhere' means one call per area.",
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG },
      exitCodes: { 1: "the area has no derivations" },
      examples: [
        "liveone derivation list kutis",
        "liveone derivation list 13 --format json",
      ],
    },
    create: {
      name: "create",
      summary: "Add a derivation to an area.",
      when:
        "Use this to start tracking a device's runs — a generator, or an EV charger. For the HWS\n" +
        "thermal model pass --kind=hws-model, which takes no points (it finds its own).",
      description:
        "--signal/--energy take a LOGICAL PATH (`load.ev/power`) or a pt_… id; prefer the path,\n" +
        "since a mis-pinned uuid fails silently — the detector simply never fires.\n" +
        "\n" +
        "One of --upper/--lower is required: they are the threshold the run is detected against.\n" +
        "Every OTHER knob is sparse by contract — a flag you do not pass is not written, so it\n" +
        "inherits the role's default (lib/run-tracking/defaults.ts) as those defaults evolve.\n" +
        "Passing a value equal to today's default is therefore NOT a no-op; it pins it.\n" +
        "\n" +
        "--energy is optional and its absence is legal: a detector with no cumulative energy\n" +
        "counter still records duration and signal statistics, and the runs card drops the kWh,\n" +
        "cost, emissions and renewable columns rather than showing them empty.",
      mutates: true,
      args: [AREA_ARG],
      flags: {
        ...BASE_URL_FLAG,
        kind: {
          type: "string",
          values: KINDS,
          default: "run-detector",
          help: "What sort of derived signal",
        },
        role: {
          type: "string",
          values: TRACKABLE_ROLES,
          help: "run-detector only: which role's runs these are",
        },
        name: {
          type: "string",
          placeholder: "text",
          help: "Display name (default: '<role> runs')",
        },
        signal: {
          type: "string",
          placeholder: "path|pt_",
          help: "run-detector only: the series to follow, e.g. load.ev/power",
        },
        energy: {
          type: "string",
          placeholder: "path|pt_",
          help: "Optional cumulative energy counter, for per-run kWh",
        },
        ...KNOB_FLAGS,
      },
      exitCodes: {
        1: "the server refused the derivation (the reason says why)",
      },
      examples: [
        "liveone derivation create kutis --role=ev --name='EV charging' --signal=load.ev/power --upper=100 --delay-off=300",
        "liveone derivation create kutis --role=ev --signal=load.ev/power --upper=100 --apply",
        "liveone derivation create kink --kind=hws-model --apply",
      ],
    },
    set: {
      name: "set",
      summary: "Change a derivation's threshold params, or rename it.",
      when:
        "Use this when a detector is firing wrongly — most often when it FRAGMENTS one long run into\n" +
        "many short ones, which means --delay-off is at or below the point's sample interval.",
      description:
        "Params are MERGED into what is stored, then sent as a whole object (the API replaces\n" +
        "`params` wholesale, and a blind replace would silently drop the knobs you did not mention).\n" +
        "Use --unset to remove a pinned knob so it goes back to inheriting the role default.\n" +
        "\n" +
        "🛑 This does NOT rewrite history. Existing intervals were detected under the OLD params and\n" +
        "stay exactly as they were until you `recompute` the window you care about.\n" +
        "\n" +
        "The signal and energy points are deliberately not editable here: re-pointing a detector\n" +
        "changes what its already-stored rows MEAN, and those rows carry the old signal's unit with\n" +
        "no way to know they predate the change. That is a considered manual operation, not a flag.",
      mutates: true,
      args: [AREA_ARG, DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...KNOB_FLAGS,
        name: { type: "string", placeholder: "text", help: "Rename it" },
        unset: {
          type: "string",
          repeatable: true,
          placeholder: "knob",
          values: KNOBS.map(([flag]) => flag),
          help: "Drop a pinned knob, so it inherits the role default again",
        },
      },
      exitCodes: { 1: "nothing to change" },
      examples: [
        "liveone derivation set kutis ev --delay-off=900",
        "liveone derivation set kutis ev --delay-off=900 --apply",
        "liveone derivation set daylesford generator --unset=hysteresis --apply",
      ],
    },
    enable: {
      name: "enable",
      summary: "Re-enable a derivation, so it is recomputed again.",
      when: "Use this after a `disable`, once whatever was wrong with its inputs is fixed.",
      mutates: true,
      args: [AREA_ARG, DERIVATION_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone derivation enable kutis ev --apply"],
    },
    disable: {
      name: "disable",
      summary:
        "Stop a derivation being recomputed. Its existing rows are untouched.",
      when:
        "This is the safe lever, and the only one: there is deliberately no delete, because\n" +
        "`derived_intervals` CASCADEs — removing a derivation would destroy every interval it ever\n" +
        "produced. A disabled derivation stops being recomputed and stops advertising its\n" +
        "capability, while its history stays exactly as it was.",
      mutates: true,
      args: [AREA_ARG, DERIVATION_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone derivation disable kutis ev --apply"],
    },
    recompute: {
      name: "recompute",
      summary: "Rebuild ONE derivation's intervals over a window.",
      when:
        "Use this to backfill history for a detector you just created, or to rebuild after changing\n" +
        "its params. The minutely cron already heals the trailing 6 hours, so this is for anything\n" +
        "older than that.",
      description:
        "🛑 regenerate and delete are DELETE-AND-REINSERT. That is safe here only because the\n" +
        "derivation is named in the request path, so this verb has no unscoped form — unlike the\n" +
        "cron's twin, whose filter is optional and through which a full-range unscoped regenerate\n" +
        "once collapsed 71 rows to 3.\n" +
        "\n" +
        "No window means ALL of this detector's history. A long span may exceed the route's 300s\n" +
        "budget; run it in --last=30d slices if so (the server chunks at 14 days internally and\n" +
        "retries transient database errors, so a re-run is cheap and safe to repeat).",
      mutates: true,
      args: [AREA_ARG, DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...WINDOW_FLAGS,
        action: {
          type: "string",
          values: ["regenerate", "aggregate", "delete"],
          default: "regenerate",
          help: "regenerate = purge then rebuild; aggregate = rebuild in place; delete = purge only",
        },
      },
      examples: [
        "liveone derivation recompute kutis ev --start=2026-07-06 --end=2026-09-01",
        "liveone derivation recompute kutis ev --last=30d --apply",
      ],
    },
    intervals: {
      name: "intervals",
      summary: "The rows a derivation has produced — runs, newest first.",
      when:
        "Use this to check what a detector actually found: after a create, after a backfill, or when\n" +
        "a dashboard's runs card looks wrong and you want the numbers behind it.",
      description:
        "Raw values, not the display strings the dashboard card's own endpoint serves — ISO instants\n" +
        "and numbers, with the unit each signal statistic is in carried PER ROW (a window can\n" +
        "straddle a detector re-point and hold two units).\n" +
        "A run belongs to a window if it STARTED in it, which is the same rule `recompute` deletes\n" +
        "by — so these are exactly the rows a recompute over the same window would replace.",
      args: [AREA_ARG, DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...WINDOW_FLAGS,
        limit: {
          type: "number",
          placeholder: "n",
          help: "Rows to return, max 500 (default 100)",
        },
        offset: { type: "number", placeholder: "n", help: "Skip this many" },
      },
      exitCodes: { 1: "no intervals in the window" },
      examples: [
        "liveone derivation intervals kutis ev --last=60d",
        "liveone derivation intervals kutis ev --last=7d --format json",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** `--last | --date | --start/--end`, as the route's JSON body wants them. Omitted = all history. */
function windowBody(ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["last", "date", "start", "end"] as const) {
    const v = str(ctx, k);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** One derivation, as one human-readable line. */
function derivationLine(d: WireDerivation): string {
  const src = Object.entries(d.sourcePoints)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const params = Object.entries(d.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return (
    `${d.id}  ${(d.enabled ? "on " : "OFF").padEnd(4)} ` +
    `${d.kind.padEnd(13)} ${(d.role ?? "-").padEnd(10)} ${d.name}\n` +
    `${" ".repeat(4)}${params || "(defaults)"}\n` +
    `${" ".repeat(4)}${src || "(no source points)"}`
  );
}

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const rows = await listDerivations(s, area);
    ctx.emit(
      {
        area: { id: area.id, name: area.displayName },
        count: rows.length,
        derivations: rows,
      },
      () =>
        [
          `${area.displayName} (${area.id})`,
          ...rows.map(derivationLine),
          "",
          `${rows.length} derivation(s).`,
        ].join("\n"),
    );
    return rows.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

/**
 * The 422 a create can come back with. `ensureRunDetector`'s refusals carry a `detail` naming the
 * member handles a detector COULD go on — the single most useful thing in this whole domain, and it
 * would be swallowed by the default 422 handling (which expects a doc-validation rejection).
 */
const CREATE_ERRORS = {
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this derivation",
    why: (b: Record<string, unknown>) =>
      [b.error, b.detail].filter(Boolean).join("\n"),
    next: "adjust the flags to match — nothing was written",
  },
} as const;

async function runCreate(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const area = await resolveArea(s, ctx.args[0]);
      const kind = str(ctx, "kind") ?? "run-detector";
      const body: Record<string, unknown> = { kind };

      if (kind === "run-detector") {
        const role = str(ctx, "role");
        if (!role)
          throw usage(
            "--role is required for a run-detector",
            "the role is half the derivation's identity (area + kind + role)",
            `pass one of: ${TRACKABLE_ROLES.join(", ")}`,
          );
        const signal = str(ctx, "signal");
        if (!signal)
          throw usage(
            "--signal is required for a run-detector",
            "a detector is defined by the series it follows",
            "pass a logical path such as --signal=load.ev/power",
          );

        // Sparse by contract: only keys actually given are sent, so anything omitted inherits
        // `detectorDefaultsForRole` as those defaults evolve. Writing a key you did not mean to pin
        // is worse than omitting it.
        const params: Record<string, unknown> = {
          signalKind: "power-threshold",
          ...knobsFrom(ctx),
        };
        if (params.upperW === undefined && params.lowerW === undefined)
          throw usage(
            "neither --upper nor --lower was given",
            "a threshold detector with no bound has nothing to detect, and the server refuses it",
            "pass --upper=<watts> (the usual form: above this, the device is on)",
          );

        const sourcePoints: Record<string, string> = {
          signal: await resolvePoint(s, area, signal, "signal"),
        };
        const energy = str(ctx, "energy");
        if (energy !== undefined)
          sourcePoints.energy = await resolvePoint(s, area, energy, "energy");

        body.role = role;
        body.name = str(ctx, "name") ?? `${role} runs`;
        body.params = params;
        body.sourcePoints = sourcePoints;
      } else {
        // hws-model declares itself by the DEVICE it models: it mints its own output point and
        // finds its own `load.hws/power` source, so there is nothing to pass.
        for (const flag of ["role", "signal", "energy"] as const)
          if (str(ctx, flag) !== undefined)
            throw usage(
              `--${flag} with --kind=hws-model`,
              "the HWS model finds its own points from the area's device",
              `drop --${flag}`,
            );
      }

      const path = `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations`;
      let created: WireDerivation | undefined;
      let status: string | undefined;
      if (!ctx.dryRun) {
        const { body: res } = await apiFetch<{
          status: string;
          derivation: WireDerivation;
        }>(s.origin, path, {
          method: "POST",
          body,
          token: s.token,
          errors: CREATE_ERRORS,
        });
        created = res.derivation;
        status = res.status;
      }

      ctx.emit(
        {
          area: { id: area.id, name: area.displayName },
          request: body,
          applied: !ctx.dryRun,
          status: status ?? null,
          derivation: created ?? null,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} create ${kind} on ${area.displayName} (${area.id})`,
            ...JSON.stringify(body, null, 2)
              .split("\n")
              .map((l) => `  ${l}`),
            created
              ? `${status === "exists" ? "already existed" : "created"}: ${created.id}`
              : "Re-run with --apply to create it.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runSet(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const area = await resolveArea(s, ctx.args[0]);
      const row = resolveDerivation(
        await listDerivations(s, area),
        ctx.args[1],
        area,
      );

      const given = knobsFrom(ctx);
      const unset = (ctx.flags.unset as string[] | undefined) ?? [];
      const name = str(ctx, "name");
      if (!Object.keys(given).length && !unset.length && name === undefined)
        throw usage(
          "nothing to set",
          "no knob, --unset or --name was given",
          "pass e.g. --delay-off=900, or --unset=hysteresis",
        );

      // MERGE, then send whole: the API replaces `params` wholesale (that is what makes removing an
      // override possible at all), so reading first is the only way to keep the knobs not mentioned.
      const params: Record<string, unknown> = { ...row.params, ...given };
      const unsetKeys = unset.map(
        (f) => KNOBS.find(([flag]) => flag === f)![1] as string,
      );
      for (const k of unsetKeys) delete params[k];

      const patch: Record<string, unknown> = { params };
      if (name !== undefined) patch.name = name;

      let updated: WireDerivation | undefined;
      if (!ctx.dryRun) {
        const { body } = await apiFetch<{ derivation: WireDerivation }>(
          s.origin,
          `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations/${encodeURIComponent(row.id)}`,
          { method: "PATCH", body: patch, token: s.token },
        );
        updated = body.derivation;
      }

      ctx.emit(
        {
          derivation: updated ?? row,
          before: row.params,
          after: params,
          applied: !ctx.dryRun,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} set ${row.name} (${row.id}) on ${area.displayName}`,
            `  params: ${JSON.stringify(row.params)}`,
            `       -> ${JSON.stringify(params)}`,
            ...(name !== undefined ? [`  name:   ${row.name} -> ${name}`] : []),
            "  existing intervals are NOT rewritten — `recompute` the window to apply this to history",
            ctx.dryRun ? "Re-run with --apply to write." : "written.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** `enable` and `disable` are one PATCH with one flipped boolean. */
function runSetEnabled(enabled: boolean): (ctx: Ctx) => Promise<number> {
  return (ctx) =>
    withApiSession(
      ctx,
      async (s) => {
        const area = await resolveArea(s, ctx.args[0]);
        const row = resolveDerivation(
          await listDerivations(s, area),
          ctx.args[1],
          area,
        );
        if (row.enabled === enabled) {
          ctx.note(`${row.id} is already ${enabled ? "enabled" : "disabled"}`);
          ctx.emit(
            { derivation: row, applied: false, changed: false },
            () =>
              `${row.name} (${row.id}) is already ${enabled ? "enabled" : "disabled"} — nothing to do.`,
          );
          return EXIT.OK;
        }

        let updated: WireDerivation | undefined;
        if (!ctx.dryRun) {
          const { body } = await apiFetch<{ derivation: WireDerivation }>(
            s.origin,
            `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations/${encodeURIComponent(row.id)}`,
            { method: "PATCH", body: { enabled }, token: s.token },
          );
          updated = body.derivation;
        }

        ctx.emit(
          {
            derivation: updated ?? row,
            enabled,
            changed: true,
            applied: !ctx.dryRun,
          },
          () =>
            [
              `${ctx.dryRun ? "would" : "WRITE"} ${enabled ? "enable" : "disable"} ` +
                `${row.name} (${row.id}) on ${area.displayName}`,
              enabled
                ? "  it will be recomputed by the minutely cron again, and re-advertise its capability"
                : "  its existing intervals are untouched; it simply stops being recomputed",
              ctx.dryRun ? "Re-run with --apply to write." : "written.",
            ].join("\n"),
        );
        return EXIT.OK;
      },
      ctx.dryRun ? "dry-run" : "APPLY",
    );
}

async function runRecompute(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const area = await resolveArea(s, ctx.args[0]);
      const row = resolveDerivation(
        await listDerivations(s, area),
        ctx.args[1],
        area,
      );
      const action = str(ctx, "action") ?? "regenerate";
      const window = windowBody(ctx);
      const scoped = `${row.name} (${row.id}) on ${area.displayName}`;
      const span = Object.keys(window).length
        ? Object.entries(window)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "ALL history";

      let result: Record<string, unknown> | undefined;
      if (!ctx.dryRun)
        result = (
          await apiFetch<Record<string, unknown>>(
            s.origin,
            `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations/${encodeURIComponent(row.id)}/recompute`,
            {
              method: "POST",
              body: { action, ...window },
              token: s.token,
              errors: {
                422: {
                  exit: EXIT.FINDINGS,
                  what: `cannot recompute ${scoped}`,
                  why: (b) => String(b.error ?? "refused"),
                  next: "nothing was written",
                },
              },
            },
          )
        ).body;

      ctx.emit(
        {
          action,
          window,
          derivation: row,
          applied: !ctx.dryRun,
          result: result ?? null,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} ${action} ${scoped} over ${span}`,
            ...(action === "regenerate" || action === "delete"
              ? [
                  "  this DELETES and reinserts — scoped to this derivation by the request path",
                ]
              : []),
            result
              ? `  purged ${result.rowsPurged ?? result.rowsDeleted ?? 0}, ` +
                `inserted ${result.rowsInserted ?? 0}, open ${result.openPeriods ?? 0}` +
                (Number(result.trackersFailed ?? 0) > 0
                  ? `  🛑 ${result.trackersFailed} failure(s) — see the server logs`
                  : "")
              : "Re-run with --apply to write.",
          ].join("\n"),
      );
      // A pass that failed its detector reported success at the HTTP layer but derived nothing.
      return result && Number(result.trackersFailed ?? 0) > 0
        ? EXIT.FINDINGS
        : EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** `3661` → `1h 1m`. Blank for an open run, which the caller renders as "running". */
function duration(seconds: number | null): string {
  if (seconds == null) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function runIntervals(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const row = resolveDerivation(
      await listDerivations(s, area),
      ctx.args[1],
      area,
    );
    const params = new URLSearchParams(windowBody(ctx));
    for (const k of ["limit", "offset"] as const) {
      const v = num(ctx, k);
      if (v !== undefined) params.set(k, String(v));
    }
    const qs = params.toString();
    const body = await s.get<{
      count: number;
      hasMore: boolean;
      intervals: WireInterval[];
    }>(
      `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations/${encodeURIComponent(row.id)}/intervals` +
        (qs ? `?${qs}` : ""),
    );

    ctx.emit({ derivation: row, ...body }, () =>
      [
        `${row.name} (${row.id}) on ${area.displayName}`,
        ...body.intervals.map((i) => {
          // The signal unit is per ROW on purpose — never hoisted into the header.
          const sig =
            i.avgSignal == null
              ? ""
              : `${i.avgSignal.toFixed(0)} ${i.signalUnit ?? "?"}`;
          return (
            `  ${i.startTime}  ${(i.endTime ? duration(i.durationSeconds) : "running").padStart(8)}` +
            `  ${sig.padStart(10)}` +
            (i.energyKwh != null ? `  ${i.energyKwh.toFixed(2)} kWh` : "") +
            (i.costC != null ? `  $${(i.costC / 100).toFixed(2)}` : "")
          );
        }),
        "",
        `${body.count} interval(s)${body.hasMore ? " (more — raise --limit or page with --offset)" : ""}.`,
      ].join("\n"),
    );
    return body.count ? EXIT.OK : EXIT.FINDINGS;
  });
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  create: runCreate,
  set: runSet,
  enable: runSetEnabled(true),
  disable: runSetEnabled(false),
  recompute: runRecompute,
  intervals: runIntervals,
};

/** Run whichever `derivation` verb was selected (the LAST path element under `liveone`). */
export async function runDerivation(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown derivation command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- derivation --help`",
    );
  return handler(ctx);
}
