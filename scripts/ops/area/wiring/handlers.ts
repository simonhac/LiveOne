/**
 * The area-wiring verbs.
 *
 * Every writer reads the current collection, changes the one thing it was asked to change, and PUTs
 * the whole thing back — the routes are full-replace, and a rewrite that forgets the rest deletes
 * it. See `index.ts`.
 */
import { EXIT, failWith, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { usage } from "../../shared";
import {
  isHelper,
  loadAggregate,
  loadPointPool,
  resolveDevices,
  resolvePoint,
  rewriteSlot,
  type WireBinding,
  type WireMember,
} from "./model";
import { chainRanks, describeBinding, renderDiff, slotOf } from "./render";
import { putBindings, putMembers } from "./client";

async function runDevicesList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const agg = await loadAggregate(s, ctx.args[0]);
    ctx.emit({ area: agg.area, members: agg.members }, () =>
      [
        `${agg.area.name} (${agg.area.id})`,
        "",
        ...agg.members.map(
          (m) =>
            `  ${m.id}  handle=${String(m.legacySystemId ?? "-").padEnd(8)} ${m.vendor.padEnd(12)} ${m.name}` +
            (isHelper(m) ? "   [server-managed]" : ""),
        ),
        "",
        `${agg.members.length} device(s).` +
          (agg.members.length === 0
            ? "  (an area with no devices resolves to no points — that is legal, not broken)"
            : ""),
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

/**
 * add / remove / set share one body: compute the target membership, diff it, PUT it.
 *
 * 🛑 Since membership became `devices.area_id`, none of the three is additive any more. `add` MOVES a
 * device here from wherever it was; `remove` makes it AMBIENT rather than deleting it; `set` does
 * both. The diff below names each consequence explicitly, because the membership list alone shows
 * only this area's half of a change that has two.
 */
function membershipWriter(
  mode: "add" | "remove" | "set",
): (ctx: Ctx) => Promise<number> {
  return async (ctx) =>
    withApiSession(
      ctx,
      async (s) => {
        const agg = await loadAggregate(s, ctx.args[0]);
        const named = await resolveDevices(s, ctx.args.slice(1));
        const current = agg.members.map((m) => m.id);

        let target: string[];
        if (mode === "add")
          target = [
            ...current,
            ...named.map((d) => d.id).filter((id) => !current.includes(id)),
          ];
        else if (mode === "remove")
          target = current.filter((id) => !named.some((d) => d.id === id));
        else target = named.map((d) => d.id);

        // 🛑 Name the AREA each joining device is taken OUT of. Membership is `devices.area_id`, so
        // a device is in 0 or 1 area and adding it here removes it from wherever it was — possibly
        // a live site with its own bindings and its own Sankey. An operator reading only
        // "devices: 3 → 4  (+ Kutis)" would have no way to know they had just emptied a slot
        // somewhere else.
        const poaching = named.filter(
          (d) => target.includes(d.id) && !current.includes(d.id) && d.areaId,
        );

        // 🛑 Name the bindings a shrink would destroy. `replaceMembers` deletes the bindings of any
        // device that leaves, and that is the leg that fails silently in both directions — an
        // operator who removes a device to "tidy up" can blank a provenance card and see only a
        // shorter device list as evidence.
        //
        // The pool is loaded ONLY when something is actually leaving. Deciding ownership needs it
        // (a binding carries a point, not a device), and a warning that cannot fire because its
        // evidence was never fetched is worse than no warning at all — it reads as "nothing to
        // lose".
        const leaving = current.filter((id) => !target.includes(id));
        const loaded = leaving.length
          ? await loadPointPool(s, agg.members)
          : { points: [], unreadable: [] };
        const pool = loaded.points;

        // 🛑 Fail CLOSED here, unlike every read path. `loadPointPool` now tolerates a member whose
        // aggregate cannot be fetched, which is right for reporting — but this verb is destructive
        // and its whole safety argument is the `doomed` list below. A departing device whose points
        // we could not read contributes nothing to that list, so the command would print "0
        // bindings would be deleted" while `replaceMembers` deletes them server-side: the precise
        // "reads as nothing to lose" failure the comment above warns about, now arriving silently
        // instead of as an error. An unreadable member that is STAYING is harmless — its bindings
        // are not at risk — so only the departing ones block.
        const blind = loaded.unreadable.filter((u) =>
          leaving.includes(u.deviceId),
        );
        if (blind.length)
          throw failWith(
            EXIT.UPSTREAM,
            `cannot enumerate what removing ${blind.length} device(s) would destroy`,
            `${blind.map((u) => `${u.name} (${u.deviceId}): ${u.reason}`).join("; ")} — their points could not be read, so any binding of theirs is invisible to the warning below, and this write DELETES a departing member's bindings`,
            "resolve the read failure first (try `liveone device points <device> --include-archived`), or remove the readable devices in a separate call",
          );
        const doomed = leaving.length
          ? agg.bindings.filter((b) => {
              const p = pool.find((x) => x.id === b.pointId);
              return p ? leaving.includes(p.deviceId) : false;
            })
          : [];

        const nameOf = (id: string) =>
          agg.members.find((m) => m.id === id)?.name ??
          named.find((d) => d.id === id)?.name ??
          id;

        const lines = renderDiff(
          "devices",
          current.map(nameOf),
          target.map(nameOf),
        );
        if (leaving.length)
          lines.push(
            "",
            `${leaving.length} device(s) become AMBIENT — in no area at all, not deleted:`,
            ...leaving.map((id) => `   ~ ${nameOf(id)}`),
          );
        if (poaching.length)
          lines.push(
            "",
            `🛑 ${poaching.length} device(s) are being TAKEN OUT of another area:`,
            ...poaching.map((d) => `   ← ${d.name} leaves "${d.areaName}"`),
            "   that area loses this device's points, and any binding onto them.",
          );
        if (doomed.length)
          lines.push(
            "",
            `🛑 ${doomed.length} binding(s) belong to a departing device and WILL BE DELETED:`,
            ...doomed.map((b) => `   - ${slotOf(b)} prio ${b.priority}`),
          );

        let members: WireMember[] | null = null;
        if (!ctx.dryRun) members = await putMembers(s, agg.area.id, target);

        ctx.emit(
          {
            area: agg.area,
            before: current,
            after: target,
            orphaned: leaving.map(nameOf),
            takenFrom: poaching.map((d) => ({
              device: d.name,
              area: d.areaName ?? null,
            })),
            bindingsDeleted: doomed.length,
            applied: !ctx.dryRun,
            members,
          },
          () =>
            [
              `${ctx.dryRun ? "would" : "WRITE"} ${mode} on ${agg.area.name} (${agg.area.id})`,
              ...lines,
              "",
              ctx.dryRun ? "Re-run with --apply to write." : "written.",
            ].join("\n"),
        );
        return EXIT.OK;
      },
      ctx.dryRun ? "dry-run" : "APPLY",
    );
}

async function runRoleList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const agg = await loadAggregate(s, ctx.args[0]);
    const { points: pool, unreadable } = await loadPointPool(s, agg.members);
    const wantPoints = ctx.flags.points === true;

    const sorted = [...agg.bindings].sort(
      (a, b) => slotOf(a).localeCompare(slotOf(b)) || a.priority - b.priority,
    );
    const boundIds = new Set(agg.bindings.map((b) => b.pointId));
    const ranks = chainRanks(agg.bindings, pool);

    ctx.emit(
      {
        area: agg.area,
        // Reported, not thrown. These members' points are absent from the pool, so any binding of
        // theirs renders as a bare `pt_` id below — the reader has to be told why rather than left
        // to infer it from a gap.
        ...(unreadable.length ? { unreadableMembers: unreadable } : {}),
        bindings: sorted.map((b) =>
          ranks.has(b.pointId) ? { ...b, chainRank: ranks.get(b.pointId) } : b,
        ),
        ...(wantPoints
          ? {
              points: pool.map((p) => ({
                id: p.id,
                device: p.deviceName,
                logicalPath: p.logicalPath,
                metricType: p.metricType,
                bound: boundIds.has(p.id),
              })),
            }
          : {}),
      },
      () => {
        const out = [`${agg.area.name} (${agg.area.id})`, ""];
        if (!sorted.length)
          out.push("  (no bindings — union-default resolution)");
        for (const b of sorted)
          out.push(`  ${describeBinding(b, pool, ranks.get(b.pointId))}`);
        out.push(
          "",
          `${sorted.length} binding(s) across ${agg.members.length} device(s).`,
        );
        if (unreadable.length) {
          out.push(
            "",
            `⚠ ${unreadable.length} member device(s) could not be read — their points are missing`,
            "  from the pool above, so any binding of theirs shows as a bare pt_ id:",
          );
          for (const u of unreadable)
            out.push(`    ${u.name} (${u.deviceId}) — ${u.reason}`);
        }
        if (wantPoints) {
          out.push("", "bindable points:");
          for (const p of [...pool].sort((a, b) =>
            (a.deviceName + a.logicalPath).localeCompare(
              b.deviceName + b.logicalPath,
            ),
          ))
            out.push(
              `  ${boundIds.has(p.id) ? "  " : "→ "}${p.deviceName}:${p.logicalPath}` +
                `${boundIds.has(p.id) ? "" : "   (unbound)"}`,
            );
          const unbound = pool.filter((p) => !boundIds.has(p.id)).length;
          out.push("", `${unbound} of ${pool.length} point(s) unbound.`);
        }
        return out.join("\n");
      },
    );
    // Findings, not OK: the answer is partial. Exit 0 here would let a scripted check pass over an
    // area it could only half read — which is the failure this verb just stopped being.
    return unreadable.length ? EXIT.FINDINGS : EXIT.OK;
  });
}

async function runRoleSet(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const agg = await loadAggregate(s, ctx.args[0]);
      const [role, metric] = [ctx.args[1], ctx.args[2]];
      const refs = ctx.args.slice(3);
      if (!refs.length)
        throw usage(
          "no point given",
          "a slot must be filled by at least one point",
          "to empty a slot use `liveone area role clear <area> <role> <metric>`",
        );

      const { points: pool } = await loadPointPool(s, agg.members);
      const picked = refs.map((r) => resolvePoint(pool, r));

      const dupe = picked.find(
        (p, i) => picked.findIndex((q) => q.id === p.id) !== i,
      );
      if (dupe)
        throw usage(
          `${dupe.deviceName}:${dupe.logicalPath} given twice`,
          "a point may fill a slot only once — priority is a total order",
          "list each point once, highest priority first",
        );

      const target = rewriteSlot(
        agg.bindings,
        role,
        metric,
        picked.map((p) => p.id),
      );

      const label = (b: WireBinding) => describeBinding(b, pool);
      const lines = renderDiff(
        "bindings",
        agg.bindings.map(label),
        target.map(label),
      );

      let bindings: WireBinding[] | null = null;
      if (!ctx.dryRun) bindings = await putBindings(s, agg.area.id, target);

      ctx.emit(
        {
          area: agg.area,
          slot: `${role}/${metric}`,
          points: picked.map((p, i) => ({
            priority: i,
            id: p.id,
            device: p.deviceName,
            logicalPath: p.logicalPath,
          })),
          applied: !ctx.dryRun,
          bindings,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} set ${role}/${metric} on ${agg.area.name} (${agg.area.id})`,
            ...picked.map(
              (p, i) => `   prio ${i}  ${p.deviceName}:${p.logicalPath}`,
            ),
            "",
            ...lines,
            "",
            ctx.dryRun ? "Re-run with --apply to write." : "written.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runRoleClear(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const agg = await loadAggregate(s, ctx.args[0]);
      const [role, metric] = [ctx.args[1], ctx.args[2]];
      const { points: pool } = await loadPointPool(s, agg.members);

      const doomed = agg.bindings.filter(
        (b) =>
          b.role === role && (metric === undefined || b.metricType === metric),
      );
      if (!doomed.length)
        throw failWith(
          EXIT.FINDINGS,
          `nothing bound at ${role}${metric ? `/${metric}` : ""}`,
          "this slot is already empty, so there is nothing to clear",
          "run `liveone area role list <area>` to see what IS bound",
        );

      const target = agg.bindings.filter((b) => !doomed.includes(b));
      const label = (b: WireBinding) => describeBinding(b, pool);
      const lines = renderDiff(
        "bindings",
        agg.bindings.map(label),
        target.map(label),
      );

      let bindings: WireBinding[] | null = null;
      if (!ctx.dryRun) bindings = await putBindings(s, agg.area.id, target);

      ctx.emit(
        {
          area: agg.area,
          cleared: doomed.map((b) => ({
            slot: slotOf(b),
            priority: b.priority,
          })),
          applied: !ctx.dryRun,
          bindings,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} clear ${role}${metric ? `/${metric}` : " (all metrics)"} on ${agg.area.name}`,
            ...lines,
            "",
            ctx.dryRun ? "Re-run with --apply to write." : "written.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** Keyed by the FULL path under `area`, because `devices set` and `role set` share a last element. */
export const WIRING_HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  "devices.list": runDevicesList,
  "devices.add": membershipWriter("add"),
  "devices.remove": membershipWriter("remove"),
  "devices.set": membershipWriter("set"),
  "role.list": runRoleList,
  "role.set": runRoleSet,
  "role.clear": runRoleClear,
};
