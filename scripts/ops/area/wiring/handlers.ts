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
import { describeBinding, renderDiff, slotOf } from "./render";
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
        `${agg.members.length} device(s).`,
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

/** add / remove / set share one body: compute the target membership, diff it, PUT it. */
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
        const pool = leaving.length ? await loadPointPool(s, agg.members) : [];
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
    const pool = await loadPointPool(s, agg.members);
    const wantPoints = ctx.flags.points === true;

    const sorted = [...agg.bindings].sort(
      (a, b) => slotOf(a).localeCompare(slotOf(b)) || a.priority - b.priority,
    );
    const boundIds = new Set(agg.bindings.map((b) => b.pointId));

    ctx.emit(
      {
        area: agg.area,
        bindings: sorted,
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
        for (const b of sorted) out.push(`  ${describeBinding(b, pool)}`);
        out.push(
          "",
          `${sorted.length} binding(s) across ${agg.members.length} device(s).`,
        );
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
    return EXIT.OK;
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

      const pool = await loadPointPool(s, agg.members);
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
      const pool = await loadPointPool(s, agg.members);

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
