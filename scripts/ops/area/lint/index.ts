/**
 * `liveone area lint` — a read-only census of the wiring states nothing else reports.
 *
 * ## Why
 *
 * The bindings plan's own verification step is *"re-run the chain census (serving keys with >1 wire
 * per area) — must return zero rows"*, and there was no command for it: the only way to ask was to
 * loop `area role list` over every area and grep the output for `chainRank`. A CLI-shaped question
 * answered by a shell loop. The same loop is the answer to the backlog's `liveone area orphans`
 * (areas with data but no devices, bindings whose point's device has left), so the two are one verb.
 *
 * ## Substrate: ONE `/api/v4/tree` call
 *
 * 🛑 Deliberately NOT `loadAggregate` + `loadPointPool` per area. That path is one request per area
 * plus one per member device — and every check here needs the point behind a binding, so a
 * fleet-wide lint would have made ~70 requests to answer one question. The inventory tree already
 * carries areas, devices (with `areaId` and `status`), points (with `logicalPath`, `metricType` and
 * `active`) and bindings, in a single authenticated read that is already in `cliTokenRoutes`.
 *
 * The payoff is bigger than the request count: with the whole graph in hand the checker is a PURE
 * function, so it is tested against a fixture rather than against a network. And the tree carries
 * `points.active`, which `chainRanks` (`../wiring/render.ts`) cannot see — the server ranks active
 * ahead of priority, so a chain whose preferred point is inactive renders `[serves]` there while the
 * server has already promoted the fallback. That divergence is a finding here.
 */
import { EXIT, failWith, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { servingKey } from "@/lib/areas/binding-chain";
import type { TreeInventory } from "@/lib/inventory/types";
import { BASE_URL_FLAG, bool, resolveArea, usage } from "../../shared";

/** The checks, in the order a report lists them. Stable — scripts match on these. */
export type LintKind =
  | "serving-key-collision"
  | "departed-device"
  | "archived-member"
  | "inactive-bound-point"
  | "area-without-devices"
  | "census-incomplete";

export interface LintFinding {
  kind: LintKind;
  areaId: string;
  areaName: string;
  /** One line, already naming the objects involved. */
  detail: string;
  /** The ids the finding is about, so a script need not parse `detail`. */
  refs: string[];
}

const AREA_ARG = {
  name: "area",
  required: false,
  help: "An area: its ar_… id, integer handle, or display name",
} as const;

export const LINT_SPEC: CommandSpec = {
  name: "lint",
  summary: "Census an area's wiring for the states nothing else reports.",
  when:
    "Use this after any bindings change, and as the fleet-wide check that a wiring migration\n" +
    "landed — `area role list` shows ONE area's bindings and cannot tell you whether two of them\n" +
    "contend, or whether a bound point's device has left.",
  description:
    "Read-only, and one `/api/v4/tree` request regardless of how many areas it checks.\n" +
    "\n" +
    "Checks:\n" +
    "  serving-key-collision  two or more wires on one `logical_path/metric_type` in one area —\n" +
    "                         two instruments measuring one quantity, of which one can serve.\n" +
    "                         This is the chain census; it must return zero rows.\n" +
    "  departed-device        a binding whose point's device is no longer in the area.\n" +
    "  archived-member        a member device that is not active — the state that used to make\n" +
    "                         `area role list` fail outright.\n" +
    "  inactive-bound-point   a bound point with `active = false`. It cannot produce a reading,\n" +
    "                         and the server ranks it BELOW its fallbacks while `role list`\n" +
    "                         still prints it as the one that serves.\n" +
    "  area-without-devices   an area with bindings or a handle but no member device.\n" +
    "  census-incomplete      a binding whose point is not in the inventory you can read, so its\n" +
    "                         serving key could not be checked. Not a clean result — re-run with\n" +
    "                         --admin.\n" +
    "\n" +
    "🛑 `--all` is explicit and has no default: naming an area and passing --all is a usage error,\n" +
    "and so is passing neither. Exit 1 when anything was found.",
  args: [AREA_ARG],
  flags: {
    ...BASE_URL_FLAG,
    all: {
      type: "boolean",
      help: "Check every area you can read, instead of one named area",
    },
    kind: {
      type: "string",
      repeatable: true,
      placeholder: "kind",
      help: "Only report these check kinds (repeatable), e.g. --kind=serving-key-collision",
    },
  },
  exitCodes: { 1: "at least one finding" },
  examples: [
    "liveone area lint kinkora",
    "liveone area lint --all",
    "liveone area lint --all --admin --kind=serving-key-collision --format=json",
  ],
  uses: ["api"],
};

// ── the checker ─────────────────────────────────────────────────────────────────────────────────

/**
 * PURE. Everything the verb decides, decided here, so the tests need no network.
 *
 * `areaIds` narrows the report; every check still reads the WHOLE tree, because a departed device
 * is by definition one that is no longer in the area being reported on.
 */
export function lintTree(
  tree: TreeInventory,
  areaIds?: Set<string>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const areaById = new Map(tree.areas.map((a) => [a.id, a]));
  const pointById = new Map(tree.points.map((p) => [p.id, p]));
  const deviceById = new Map(tree.devices.map((d) => [d.id, d]));
  const inScope = (id: string) => !areaIds || areaIds.has(id);
  const nameOf = (id: string) => areaById.get(id)?.name ?? "(unknown area)";
  const add = (
    kind: LintKind,
    areaId: string,
    detail: string,
    refs: string[],
  ) => findings.push({ kind, areaId, areaName: nameOf(areaId), detail, refs });

  // 1 + 4 — per-area binding checks.
  const byArea = new Map<string, typeof tree.bindings>();
  for (const b of tree.bindings) {
    const list = byArea.get(b.areaId);
    if (list) list.push(b);
    else byArea.set(b.areaId, [b]);
  }

  for (const [areaId, bindings] of byArea) {
    if (!inScope(areaId)) continue;

    // 🛑 Group on the SERVING KEY, from `lib/areas/binding-chain.ts` — not on the (role, metric)
    // slot. A `load` slot legitimately holds `load.hvac/power`, `load.pool/power` and
    // `load.ev/power` all serving at once; what cannot coexist is two wires on ONE key. Re-deriving
    // that grouping here is exactly the mistake `binding-chain.ts` was written to end.
    const byKey = new Map<string, typeof bindings>();
    for (const b of bindings) {
      const p = pointById.get(b.pointId);
      // A stemless point claims no path, so it can never contend. `servingKey` says so; honour it
      // rather than inventing a key from the binding's own `metric`.
      const key = p ? servingKey(p.logicalPath ?? null, p.metric) : null;
      if (key === null) continue;
      const list = byKey.get(key);
      if (list) list.push(b);
      else byKey.set(key, [b]);
    }
    // 🛑 A binding whose point is not in the payload is NOT a clean binding — it is one this census
    // could not see. The tree carries the points of devices the caller can read; an owned area may
    // legitimately bind an ownerless public device, whose points can be absent. Skipping those
    // silently is how a collision or an inactive point hides behind a "no findings" result, which
    // is worse than reporting nothing at all.
    const unseen = bindings.filter((b) => !pointById.has(b.pointId));
    if (unseen.length)
      add(
        "census-incomplete",
        areaId,
        `${unseen.length} binding(s) reference points absent from this inventory, so their serving keys could not be checked — re-run with --admin`,
        unseen.map((b) => b.pointId),
      );

    for (const [key, list] of byKey) {
      if (list.length < 2) continue;
      const who = [...list]
        .sort((a, b) => a.priority - b.priority)
        .map((b) => {
          const p = pointById.get(b.pointId);
          const d = p ? deviceById.get(p.deviceId) : undefined;
          return `${d?.name ?? "?"}@${b.priority}`;
        });
      add(
        "serving-key-collision",
        areaId,
        `${key} has ${list.length} wires: ${who.join(", ")}`,
        list.map((b) => b.pointId),
      );
    }

    for (const b of bindings) {
      const p = pointById.get(b.pointId);
      if (!p) continue;
      const d = deviceById.get(p.deviceId);
      // `areaId === null` is AMBIENT, and `replaceBindings` permits binding an ownerless/ambient
      // device on purpose (the OpenElectricity NEM regions live there permanently). Flagging those
      // would make the check cry wolf on the fleet's most stable wiring.
      if (d && d.areaId !== null && d.areaId !== areaId)
        add(
          "departed-device",
          areaId,
          `${p.logicalPath ?? p.path}/${p.metric} is bound here but its device ${d.name} is now in ${nameOf(d.areaId)}`,
          [b.pointId, d.id],
        );
      if (!p.active)
        add(
          "inactive-bound-point",
          areaId,
          `${p.logicalPath ?? p.path}/${p.metric} on ${d?.name ?? "?"} is bound but inactive — the server ranks it below its fallbacks`,
          [b.pointId],
        );
    }
  }

  // 2 + 3 — per-area membership checks.
  const membersByArea = new Map<string, typeof tree.devices>();
  for (const d of tree.devices) {
    if (!d.areaId) continue;
    const list = membersByArea.get(d.areaId);
    if (list) list.push(d);
    else membersByArea.set(d.areaId, [d]);
  }
  for (const a of tree.areas) {
    if (!inScope(a.id)) continue;
    const members = membersByArea.get(a.id) ?? [];
    for (const d of members)
      if (d.status !== "active")
        add(
          "archived-member",
          a.id,
          `member ${d.name} (${d.id}) is ${d.status}`,
          [d.id],
        );
    if (members.length === 0) {
      const bindings = byArea.get(a.id)?.length ?? 0;
      const hasData = a.provenance.batteryDays > 0 || a.provenance.flowDays > 0;
      if (bindings > 0 || hasData)
        add(
          "area-without-devices",
          a.id,
          `no member devices, but ${bindings} binding(s) and ${a.provenance.batteryDays} fold day(s) / ${a.provenance.flowDays} flow day(s) remain`,
          [a.id],
        );
    }
  }

  return findings.sort(
    (x, y) =>
      x.kind.localeCompare(y.kind) ||
      x.areaName.localeCompare(y.areaName) ||
      x.detail.localeCompare(y.detail),
  );
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────

export function renderLint(
  checked: number,
  findings: LintFinding[],
  scope: string,
): string {
  if (findings.length === 0) return `${checked} area(s) checked — no findings.`;
  const lines: string[] = [];
  let kind: string | null = null;
  for (const f of findings) {
    if (f.kind !== kind) {
      kind = f.kind;
      lines.push(lines.length ? "" : "", kind);
    }
    lines.push(`  ${f.areaName}  (${f.areaId})`, `    ${f.detail}`);
  }
  lines.push(
    "",
    `${findings.length} finding(s) across ${checked} area(s)${scope ? ` (${scope})` : ""}.`,
  );
  return lines.join("\n").replace(/^\n/, "");
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────────

export async function runLint(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const ref = ctx.args[0];
    const all = bool(ctx, "all");
    // 🛑 Explicit, both ways — the same rule `device config lint` states. A default of "everything"
    // would make a fleet sweep something you get by accident; a default of "nothing" would make the
    // verb silently answer about nothing at all.
    if (ref && all)
      throw usage(
        "an area and --all",
        "these name different scopes",
        "pass one area, or --all",
      );
    if (!ref && !all)
      throw usage(
        "no area named",
        "lint needs to know what to check",
        "pass an area, or --all for every area you can read",
      );

    let areaIds: Set<string> | undefined;
    if (ref) {
      // Resolved through the shared resolver so a handle, slug or name works here exactly as it
      // does everywhere else — and archived areas are excluded for the same reason they are there.
      const area = await resolveArea(s, ref);
      areaIds = new Set([area.id!]);
    }

    const tree = await s.get<TreeInventory>("/api/v4/tree");
    // 🛑 Refuse rather than mislead. `logicalPath` on a tree point is what a serving key is BUILT
    // from, and it was added to the inventory payload for this verb. Against a deployment that
    // predates it the key is absent, not null, so every stemless point in an area would group
    // together under one `undefined/<metric>` bucket and be reported as a collision — the verb
    // would confidently invent the exact finding it exists to rule out. An absent KEY is
    // distinguishable from a present null, so this is a precise check, not a heuristic.
    if (tree.points.length && !tree.points.some((p) => "logicalPath" in p))
      throw failWith(
        EXIT.UPSTREAM,
        `${s.origin} serves an inventory without point logical paths`,
        "serving keys are built from `points.logical_path`, and this deployment's /api/v4/tree does not carry it — every check below would be wrong rather than merely unavailable",
        "deploy this branch, or check the build sha with `liveone auth whoami`",
      );
    const wanted = (ctx.flags.kind as string[] | undefined) ?? [];
    if (wanted.length) {
      const known: LintKind[] = [
        "serving-key-collision",
        "departed-device",
        "archived-member",
        "inactive-bound-point",
        "area-without-devices",
        "census-incomplete",
      ];
      const bad = wanted.filter((k) => !known.includes(k as LintKind));
      if (bad.length)
        throw usage(
          `unknown --kind ${bad.join(", ")}`,
          "that is not one of this verb's checks",
          `pass one of: ${known.join(", ")}`,
        );
    }

    const findings = lintTree(tree, areaIds).filter(
      (f) => !wanted.length || wanted.includes(f.kind),
    );
    const checked = areaIds ? areaIds.size : tree.areas.length;
    const scope = tree.scope === "fleet" ? "fleet" : "your own";

    ctx.emit({ checked, scope: tree.scope, findings }, () =>
      renderLint(checked, findings, scope),
    );
    return findings.length ? EXIT.FINDINGS : EXIT.OK;
  });
}

export const LINT_HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  lint: runLint,
};
