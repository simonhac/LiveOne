/**
 * The `derivation` verbs, and the dispatcher that selects one.
 */
import { EXIT, bool, num, str, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch, type ErrorOverride } from "@/lib/cli-kit/http";
import { Device, Point } from "@/lib/ids";
import { dependentLines, usage } from "../shared";
import {
  KNOBS,
  TRACKABLE_ROLES,
  deviceNames,
  devicesById,
  knobsFrom,
  listDerivations,
  listDevices,
  narrowFrom,
  deviceFromRef,
  resolveBoundaryPoint,
  resolveDerivation,
  resolvePoint,
  resolveScope,
  type WireDerivation,
  type WireDevice,
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

/**
 * The 403 this surface can answer with, rendered rather than passed through.
 *
 * `lib/cli-kit/http.ts`'s default 403 is written for a dashboard doc ("can only be repaired with
 * --via=db") — advice that is wrong twice over here: there is no db transport in this domain, and
 * the actual cause is specific and fixable. Authorization is against EVERY device a derivation
 * touches, so the refusal carries the ones that said no; a bare "Forbidden" on a two-device
 * detector is the least actionable thing this model can emit.
 */
const SCOPE_403: ErrorOverride = {
  exit: EXIT.FINDINGS,
  what: "write access is required on every device this derivation touches",
  why: (b) => {
    const detail = b.detail as Record<string, unknown> | undefined;
    const devices = detail?.devices;
    const named =
      Array.isArray(devices) && devices.length > 0
        ? devices.map((d) => {
            const x = d as Record<string, unknown>;
            return `  ${String(x.id)}  ${String(x.name)}`;
          })
        : [];
    const hidden = Number(detail?.hiddenDevices ?? 0);
    return [
      String(b.error ?? "forbidden"),
      ...named,
      // Counted, never named: a device you cannot already see is not introduced to you by a refusal.
      ...(hidden > 0
        ? [`  …and ${hidden} device(s) that are not yours to see`]
        : []),
    ].join("\n");
  },
  next: "ask the owner of those devices, or run as an admin — nothing was written",
};

/**
 * A refused write, said in the server's own words.
 *
 * Without this, `apiFetch`'s default 422 throws `DocInvalidError` — which is written for a
 * DASHBOARD DOC rejection, reads `body.errors`/`body.warnings`, and therefore DISCARDS `body.error`
 * entirely. Every 422 this domain can answer with is a plain `{error}`: a boundary on an hws-model,
 * an unknown boundary point, a disabled detector asked to recompute, an empty patch. The operator
 * would have got "the document was rejected by the server's validator" and no reason at all.
 */
const REFUSAL_422: ErrorOverride = {
  exit: EXIT.FINDINGS,
  what: "the server refused this change",
  why: (b) => [b.error, b.detail].filter(Boolean).map(String).join("\n"),
  next: "nothing was written",
};

/** Every mutating verb speaks this vocabulary. */
export const WRITE_ERRORS = { 403: SCOPE_403, 422: REFUSAL_422 } as const;

/**
 * The 422 a create can come back with. `ensureRunDetector`'s refusals carry a `detail` naming what
 * is wrong — for `owner-role-taken`, the `dx_` of the detector that already owns the device — and
 * it would otherwise be swallowed by the default 422 handling (which expects a doc-validation
 * rejection).
 */
const CREATE_ERRORS = {
  ...WRITE_ERRORS,
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this derivation",
    why: (b: Record<string, unknown>) =>
      [b.error, b.detail].filter(Boolean).join("\n"),
    next: "adjust the flags to match — nothing was written",
  },
} as const;

/**
 * The two DELETE interlocks, as the operator sees them.
 *
 * `derivation-enabled` and `relied-upon` are both 409s and they mean opposite things about what to
 * do next — one is waivable and one deliberately is not — so they are told apart by `detail.code`
 * rather than sharing the shared 409 handler's "pick a different slug".
 */
export const DELETE_ERRORS = {
  ...WRITE_ERRORS,
  409: {
    exit: EXIT.FINDINGS,
    what: "the server refused to delete it",
    why: (b: Record<string, unknown>) => {
      const detail = b.detail as Record<string, unknown> | undefined;
      const deps = dependentLines(b);
      return [
        String(b.error ?? "conflict"),
        ...(deps ?? []),
        ...(detail?.fix ? [String(detail.fix)] : []),
      ].join("\n");
    },
    next: "nothing was deleted — resolve what it named, or repeat with --force (which does NOT waive the disabled-first interlock)",
  },
} as const;

/** One derivation, as one human-readable line. */
function derivationLine(
  d: WireDerivation,
  byId: Map<string, WireDevice>,
): string {
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
    `${" ".repeat(4)}on ${deviceNames(d, byId)}\n` +
    `${" ".repeat(4)}${params || "(defaults)"}\n` +
    `${" ".repeat(4)}${src || "(no source points)"}`
  );
}

/**
 * What every verb but `list` and `create` starts with: the derivation, plus the devices needed to
 * talk about it.
 *
 * 🛑 The listing it resolves against is FLEET-WIDE — that is the whole change. `--device`/`--area`
 * narrow it when a role would otherwise name two rows, and the ambiguity refusal says so; they are
 * not part of the address, and nothing here binds the row to them.
 */
async function target(
  ctx: Ctx,
  s: ApiSession,
): Promise<{
  row: WireDerivation;
  byId: Map<string, WireDevice>;
  where: string;
}> {
  const devices = await listDevices(s);
  const { filter, label } = await narrowFrom(ctx, s, devices);
  const byId = devicesById(devices);
  const row = resolveDerivation(
    await listDerivations(s, filter),
    ctx.args[0],
    label,
    byId,
  );
  return { row, byId, where: deviceNames(row, byId) };
}

/** The item address. There is exactly one, and no area appears in it. */
const at = (row: WireDerivation) =>
  `/api/v4/derivations/${encodeURIComponent(row.id)}`;

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    // Not `atMostOne`: the parser defaults an unsupplied boolean to `false`, so both would always
    // read as present. See the note on `atMostOne` itself.
    if (bool(ctx, "enabled") && bool(ctx, "disabled"))
      throw usage(
        "--enabled and --disabled",
        "nothing is both, so together they can only ever match an empty list",
        "pass one of them, or neither to list both",
      );
    const scopeRef = ctx.args[0];
    // 🛑 `!== undefined`, not truthiness: `--device=` parses to the empty STRING, which is falsy —
    // so a truthy test would let `list A --device= --area=B` past this check and then silently drop
    // both flags in the positional branch below. Same absent-vs-empty class as the boolean trap.
    if (
      scopeRef !== undefined &&
      (str(ctx, "device") !== undefined || str(ctx, "area") !== undefined)
    )
      throw usage(
        `a positional scope AND --device/--area`,
        "they are two spellings of the same narrowing, and honouring both would silently intersect them",
        "pass the scope once — as the positional, or as the flag",
      );

    const devices = await listDevices(s);
    const byId = devicesById(devices);
    const { filter, label } =
      scopeRef !== undefined
        ? await resolveScope(s, scopeRef, devices)
        : await narrowFrom(ctx, s, devices);
    // Say which way a NAME went. Device-first is right for the common case (a device and its
    // area-of-one share a display name, and their derivation sets are the same), but nothing stops
    // an area being named after a device it does not contain — in which case the two sets are
    // disjoint rather than nested, and silence would be the CLI answering a different question.
    // An id is unambiguous by construction, so it says nothing.
    if (scopeRef !== undefined && filter.device && !Device.is(scopeRef))
      ctx.note(
        `"${scopeRef}" resolved as a ${label} — pass --area=${scopeRef} if you meant the area`,
      );

    for (const k of ["kind", "role"] as const) {
      const v = str(ctx, k);
      if (v !== undefined) filter[k] = v;
    }
    if (bool(ctx, "enabled")) filter.enabled = true;
    if (bool(ctx, "disabled")) filter.enabled = false;

    const rows = await listDerivations(s, filter);
    ctx.emit(
      { scope: label, filter, count: rows.length, derivations: rows },
      () =>
        [
          `derivations — ${label}`,
          ...rows.map((r) => derivationLine(r, byId)),
          "",
          `${rows.length} derivation(s).`,
        ].join("\n"),
    );
    return rows.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

async function runCreate(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      // `deviceFromRef`, not the listing alone: a `dv_` is an address, and the listing is narrower
      // than the set a derivation may touch. Naming an id the listing omits then works exactly as
      // far as it can — the create is authorized server-side — with `--signal=pt_…` doing the rest,
      // since that device's point inventory is equally unreadable.
      const device = deviceFromRef(await listDevices(s), ctx.args[0]);
      const kind = str(ctx, "kind") ?? "run-detector";
      const body: Record<string, unknown> = { kind };

      if (kind === "run-detector") {
        const role = str(ctx, "role");
        if (!role)
          throw usage(
            "--role is required for a run-detector",
            "the role is half the derivation's identity (its owner device + kind + role)",
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
          signal: await resolvePoint(s, device, signal, "signal"),
        };
        const energy = str(ctx, "energy");
        if (energy !== undefined)
          sourcePoints.energy = await resolvePoint(s, device, energy, "energy");

        body.role = role;
        body.name = str(ctx, "name") ?? `${role} runs`;
        body.params = params;
        body.sourcePoints = sourcePoints;
      } else {
        // hws-model declares itself by the DEVICE it models: it mints its own output point and
        // finds its own `load.hws/power` source, so the device is the only input.
        for (const flag of ["role", "signal", "energy"] as const)
          if (str(ctx, flag) !== undefined)
            throw usage(
              `--${flag} with --kind=hws-model`,
              "the HWS model finds its own points on the device it models",
              `drop --${flag}`,
            );
        body.device = device.id;
      }

      let created: WireDerivation | undefined;
      let status: string | undefined;
      if (!ctx.dryRun) {
        const { body: res } = await apiFetch<{
          status: string;
          derivation: WireDerivation;
        }>(s.origin, "/api/v4/derivations", {
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
          device: { id: device.id, name: device.name },
          request: body,
          applied: !ctx.dryRun,
          status: status ?? null,
          derivation: created ?? null,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} create ${kind} about ${device.name} (${device.id})`,
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
      const { row, byId, where } = await target(ctx, s);

      const given = knobsFrom(ctx);
      const unset = (ctx.flags.unset as string[] | undefined) ?? [];
      const name = str(ctx, "name");
      const boundary = str(ctx, "boundary");
      const clearBoundary = bool(ctx, "clearBoundary");
      if (boundary !== undefined && clearBoundary)
        throw usage(
          "--boundary and --clear-boundary",
          "one sets the boundary point and the other removes it",
          "pass whichever you meant",
        );
      if (
        !Object.keys(given).length &&
        !unset.length &&
        name === undefined &&
        boundary === undefined &&
        !clearBoundary
      )
        throw usage(
          "nothing to set",
          "no knob, --unset, --name or --boundary was given",
          "pass e.g. --delay-off=900, or --unset=hysteresis",
        );

      // MERGE, then send whole: the API replaces `params` wholesale (that is what makes removing an
      // override possible at all), so reading first is the only way to keep the knobs not mentioned.
      const params: Record<string, unknown> = { ...row.params, ...given };
      const unsetKeys = unset.map(
        (f) => KNOBS.find(([flag]) => flag === f)![1] as string,
      );
      for (const k of unsetKeys) delete params[k];

      // 🛑 `params` is sent ONLY when a knob was actually touched. Sending it regardless makes every
      // rename and every boundary edit a read-modify-write over the thresholds too, so a concurrent
      // `--upper` change made between this command's read and its PATCH would be silently reverted
      // by an operation that had nothing to do with thresholds. `params` is a whole-object replace
      // with no revision check, so the only defence is not to send it when it was not asked for.
      const touchesParams = Object.keys(given).length > 0 || unset.length > 0;
      const patch: Record<string, unknown> = touchesParams ? { params } : {};
      if (name !== undefined) patch.name = name;

      // The boundary is a run-detector slot; an hws-model has only `power`. The server refuses it
      // before touching anything, but a dry run that cheerfully described the edit and an --apply
      // that could only ever 422 is a dry run describing something impossible.
      if (
        (boundary !== undefined || clearBoundary) &&
        row.kind !== "run-detector"
      )
        throw usage(
          `--${clearBoundary ? "clear-boundary" : "boundary"} on a ${row.kind}`,
          "the boundary is a run-detector slot — it is where two adjacent RUNS are divided, and an hws-model produces no runs",
          "drop the flag; there is nothing on this derivation for it to move",
        );

      let boundaryLine: string | undefined;
      /** The `pt_` the boundary is moving TO, for the report. Null when it is being cleared. */
      let boundaryPointId: string | null | undefined;
      if (clearBoundary) {
        patch.boundaryPointUid = null;
        boundaryPointId = null;
        boundaryLine = `  boundary: ${row.sourcePoints.boundary ?? "(unset)"} -> (cleared)`;
      } else if (boundary !== undefined) {
        const pointId = await resolveBoundaryPoint(s, row, boundary, byId);
        boundaryPointId = pointId;
        // 🛑 The one field on this surface that crosses as a RAW uuid rather than a `pt_`: the route
        // reads `boundaryPointUid` straight into `points.id`. Decoded here so the operator still
        // speaks the one point vocabulary everything else uses, and so a malformed id is a local
        // refusal rather than an "Unknown boundary point" from prod.
        const uuid = Point.toUuidOrNull(pointId);
        if (!uuid)
          throw usage(
            `"${pointId}" is not a point id`,
            "--boundary resolved to something that is not a pt_… id",
            "pass a pt_… id, a logical path, or <device>:<logical-path>",
          );
        patch.boundaryPointUid = uuid;
        boundaryLine = `  boundary: ${row.sourcePoints.boundary ?? "(unset)"} -> ${pointId}`;
      }

      let updated: WireDerivation | undefined;
      if (!ctx.dryRun) {
        const { body } = await apiFetch<{ derivation: WireDerivation }>(
          s.origin,
          at(row),
          {
            method: "PATCH",
            body: patch,
            token: s.token,
            errors: WRITE_ERRORS,
          },
        );
        updated = body.derivation;
      }

      ctx.emit(
        {
          derivation: updated ?? row,
          // The REQUEST, verbatim — the dry run's whole job. Without it a `--boundary`/`--name`-only
          // run reported identical params and nothing else, so the JSON (the default off a terminal)
          // said "no change" about a write that re-points the detector and can widen its device set.
          request: patch,
          before: {
            params: row.params,
            boundary: row.sourcePoints.boundary ?? null,
          },
          // 🛑 Once written, `after` is read back off the RETURNED ROW, not off what this command
          // projected. The two differ whenever another writer touched a field this patch did not
          // send — which is exactly the case `params`-only-when-asked exists to preserve — and a
          // report whose `after` contradicted the `derivation` beside it, both under
          // `applied: true`, would be worse than the lost update it replaced. The projection is
          // still what a DRY RUN shows, because there is no returned row to prefer.
          after: updated
            ? {
                params: updated.params,
                boundary: updated.sourcePoints.boundary ?? null,
              }
            : {
                params: touchesParams ? params : row.params,
                boundary:
                  patch.boundaryPointUid === undefined
                    ? (row.sourcePoints.boundary ?? null)
                    : (boundaryPointId ?? null),
              },
          applied: !ctx.dryRun,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} set ${row.name} (${row.id}) on ${where}`,
            // Only when a knob was touched — an unchanged before/after pair printed on every rename
            // reads as "these were considered and left alone", which is not what happened: they were
            // not sent at all.
            ...(touchesParams
              ? [
                  `  params: ${JSON.stringify(row.params)}`,
                  `       -> ${JSON.stringify(params)}`,
                ]
              : []),
            ...(name !== undefined ? [`  name:   ${row.name} -> ${name}`] : []),
            ...(boundaryLine ? [boundaryLine] : []),
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
        const { row, where } = await target(ctx, s);
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
            at(row),
            {
              method: "PATCH",
              body: { enabled },
              token: s.token,
              errors: WRITE_ERRORS,
            },
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
                `${row.name} (${row.id}) on ${where}`,
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
 * DELETE, and the one interlock this CLI checks for itself.
 *
 * The disabled-first rule is enforced server-side (409 `derivation-enabled`, unwaivable) and
 * re-stated in the DELETE's own WHERE clause, so checking it here changes no outcome — but a dry
 * run that cheerfully described destroying a LIVE detector, only for `--apply` to refuse, would be
 * a dry run that described something that cannot happen.
 *
 * What is deliberately NOT duplicated is the dependency scan: `refuseIfReliedUpon` enumerates the
 * intervals, the output point and any automation, and there is no read endpoint that answers the
 * same question. So the flow is: `--apply` → 409 naming what would break → `--force`. The refusal
 * IS the confirmation prompt, and it is written by the side that knows the answer.
 */
async function runDelete(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const { row, where } = await target(ctx, s);
      const force = bool(ctx, "force");

      if (row.enabled)
        throw usage(
          `${row.name} (${row.id}) is still enabled`,
          "a live derivation cannot be deleted, and --force does not waive it: disabling is one reversible command, and it makes you watch the thing stop before it is destroyed",
          `run \`liveone derivation disable ${row.id} --apply\` first`,
        );

      let result: Record<string, unknown> | undefined;
      if (!ctx.dryRun)
        result = (
          await apiFetch<Record<string, unknown>>(
            s.origin,
            `${at(row)}${force ? "?force=true" : ""}`,
            { method: "DELETE", token: s.token, errors: DELETE_ERRORS },
          )
        ).body;

      const forced = Array.isArray(result?.forced) ? result.forced : [];
      ctx.emit(
        {
          derivation: row,
          force,
          applied: !ctx.dryRun,
          destroyed: forced,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} DELETE ${row.name} (${row.id}) on ${where}`,
            "  🛑 every interval it ever produced goes with it (derived_intervals CASCADEs)",
            ...(force
              ? [
                  "  --force: anything still relying on it is overridden rather than refused",
                ]
              : [
                  "  without --force the server refuses while anything still relies on it, and names what",
                ]),
            result
              ? forced.length === 0
                ? "deleted. Nothing else relied on it."
                : [
                    `deleted, overriding ${forced.length} dependent(s):`,
                    ...forced.map((d) => {
                      const x = d as Record<string, unknown>;
                      return `  ${String(x.kind)} ${String(x.name ?? "")} (${String(x.id)}) — ${String(x.effect)}`;
                    }),
                  ].join("\n")
              : "Re-run with --apply to delete it.",
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
      const { row, where } = await target(ctx, s);
      const action = str(ctx, "action") ?? "regenerate";
      const window = windowBody(ctx);
      const scoped = `${row.name} (${row.id}) on ${where}`;
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
            `${at(row)}/recompute`,
            {
              method: "POST",
              body: { action, ...window },
              token: s.token,
              errors: {
                ...WRITE_ERRORS,
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
    const { row, where } = await target(ctx, s);
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
    }>(`${at(row)}/intervals${qs ? `?${qs}` : ""}`);

    ctx.emit({ derivation: row, ...body }, () =>
      [
        `${row.name} (${row.id}) on ${where}`,
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
  delete: runDelete,
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
