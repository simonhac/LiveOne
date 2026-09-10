/**
 * The `derivation` verbs, and the dispatcher that selects one.
 */
import { EXIT, num, str, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { usage } from "../shared";
import {
  KNOBS,
  TRACKABLE_ROLES,
  knobsFrom,
  listDerivations,
  resolveArea,
  resolveDerivation,
  resolvePoint,
  type WireDerivation,
  type WireInterval,
} from "./model";

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

/**
 * The fragmentation warning, and the reason it is worth a line of its own.
 *
 * `delayOff` is tested against a SAMPLE GAP, so a detector whose signal is polled at or slower than
 * that value closes a run on almost every poll. The output is not malformed — each fragment is a
 * valid run with a valid duration and valid statistics — so `inserted`, `open` and `failures` all
 * read healthy. The Kutis EV backfill returned 408 "sessions" for 27 real charges and said nothing.
 *
 * `runsSplitByDataGap` counts the runs that began without the device ever being seen off since the
 * previous one ended. A device that genuinely stopped leaves below-threshold samples behind; a late
 * poll leaves nothing, because absence is what made the gap. A high proportion means the pass is
 * reporting artefacts.
 */
function fragmentationLines(
  result: Record<string, unknown> | undefined,
): string[] {
  const split = Number(result?.runsSplitByDataGap ?? 0);
  if (!result || split === 0) return [];
  const inserted = Number(result.rowsInserted ?? 0);
  const pct = inserted > 0 ? Math.round((split / inserted) * 100) : 0;
  return [
    `  ⚠ ${split} of ${inserted} run(s) began with no off-sample since the previous one` +
      ` — split by missing data, not by the device stopping`,
    ...(pct >= 50
      ? [
          `    ${pct}% is too many to be outages: check --delay-off against the signal's` +
            ` sample interval (\`liveone derivation intervals\` shows the run spacing)`,
        ]
      : []),
  ];
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
            // The one number that makes fragmentation visible. Everything else in this summary looks
            // healthy while a detector shreds a six-hour charge into eighty-odd pieces, because a
            // fragment is a perfectly well-formed run — it is only the ABSENCE of an off-sample
            // between them that says the device never actually stopped.
            ...fragmentationLines(result),
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
