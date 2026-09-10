/**
 * The `owner` verbs.
 *
 * `transfer` builds the plan CLIENT-side and posts an explicit id set. That is deliberate: the
 * route writes and does not take a `dryRun` flag, so the only way a dry run can be honest is for
 * the thing it prints to be literally the thing that would be sent.
 */
import { EXIT, failWith, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { bool, str, usage } from "../shared";
import { resolveUserId } from "../user/cli";
import {
  areaMemberDevices,
  csv,
  dashboardsReferencing,
  requireSomething,
  resolveArea,
  resolveDashboard,
  resolveDevice,
  type TransferPlan,
} from "./model";

interface WireTransferResult {
  transferred: Array<{
    kind: string;
    id: string;
    name: string | null;
    fromUserId: string | null;
    toUserId: string;
  }>;
  grantsWritten: Array<{
    dashboardId: string;
    userId: string;
    role: string;
  }>;
  warnings: string[];
}

const TRANSFER_ERRORS = {
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this transfer",
    why: (b: Record<string, unknown>) => String(b.error ?? "refused"),
    next: "nothing moved — the objects are as they were",
  },
  403: {
    exit: EXIT.FINDINGS,
    what: "ownership transfer is admin-only",
    why: (b: Record<string, unknown>) => String(b.error ?? "forbidden"),
    next: "check `liveone auth whoami`",
  },
  // 🛑 Same shape as the area-wiring 404: the ids resolved a moment ago through this very origin,
  // so a 404 here is the Clerk edge on a deployment that predates this route, not a bad id.
  404: {
    exit: EXIT.FINDINGS,
    what: "this deployment has no ownership-transfer route",
    why: () =>
      "everything named resolved, so the ids are right — the edge 404-rewrote the POST before any handler ran",
    next: "check the deployed build with `liveone auth whoami`; this needs the release that added /api/v4/ownership/transfer",
  },
} as const;

/**
 * Read an owner off an aggregate, keeping "the deployment did not tell me" separate from "there is
 * no owner".
 *
 * 🛑 `body.ownerUserId ?? null` collapses those two, and they mean opposite things: `null` is an
 * OWNERLESS object, which is PUBLIC-READ (`requireDeviceAccess`: `isPublic = ownerUserId == null`),
 * while `undefined` is a deployment that predates the field. Conflating them made this verb report
 * every area on prod as "ownerless — public read" purely because the deployed area route did not
 * carry the field yet — an alarming, entirely false, security finding.
 */
export function ownerOf(body: Record<string, unknown>): {
  ownerUserId: string | null;
  ownerKnown: boolean;
} {
  const known = "ownerUserId" in body;
  return {
    ownerUserId: known ? ((body.ownerUserId as string | null) ?? null) : null,
    ownerKnown: known,
  };
}

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const ref = ctx.args[0];
    const found: Array<Record<string, unknown>> = [];

    // Try each kind. A ref that names two KINDS of thing is a real possibility (an integer handle
    // addresses both a device and its area-of-one), so all three are reported rather than the first.
    const tryOne = async (fn: () => Promise<Record<string, unknown>>) => {
      try {
        found.push(await fn());
      } catch {
        /* not this kind */
      }
    };
    await tryOne(async () => {
      const d = await resolveDevice(s, ref);
      const full = await s.get<Record<string, unknown>>(
        `/api/v4/devices/${encodeURIComponent(d.id)}`,
      );
      return { kind: "device", id: d.id, name: d.name, ...ownerOf(full) };
    });
    await tryOne(async () => {
      const a = await resolveArea(s, ref);
      const full = await s.get<{ area: Record<string, unknown> }>(
        `/api/v4/areas/${encodeURIComponent(a.id!)}`,
      );
      return {
        kind: "area",
        id: a.id,
        name: a.displayName,
        ...ownerOf(full.area ?? {}),
      };
    });
    await tryOne(async () => {
      const d = await resolveDashboard(s, ref);
      const full = await s.get<Record<string, unknown>>(
        `/api/v4/dashboards/${encodeURIComponent(d.id)}`,
      );
      return { kind: "dashboard", id: d.id, name: d.name, ...ownerOf(full) };
    });

    if (!found.length)
      throw failWith(
        EXIT.FINDINGS,
        `nothing matches "${ref}"`,
        "no device, area or dashboard has that id, handle, slug or name",
        "run `liveone device list`, `liveone area list` or `liveone dashboard list`",
      );

    const describeOwner = (f: Record<string, unknown>) =>
      !f.ownerKnown
        ? "(owner not reported by this deployment)"
        : ((f.ownerUserId as string | null) ?? "(OWNERLESS — public read)");

    const anyUnknown = found.some((f) => !f.ownerKnown);
    ctx.emit({ ref, matches: found }, () =>
      [
        ...found.map(
          (f) =>
            `${String(f.kind).padEnd(10)} ${String(f.id).padEnd(30)} ` +
            `${describeOwner(f).padEnd(40)} ${f.name}`,
        ),
        "",
        `${found.length} match(es).`,
        ...(anyUnknown
          ? [
              "",
              "⚠️ Some rows could not report an owner: this deployment's aggregate does not carry",
              "   `ownerUserId`. That is NOT the same as ownerless — do not read it as public.",
            ]
          : []),
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function buildPlan(s: ApiSession, ctx: Ctx): Promise<TransferPlan> {
  const plan: TransferPlan = {
    devices: [],
    areas: [],
    dashboards: [],
    referencingNotIncluded: [],
  };

  for (const ref of csv(str(ctx, "devices"))) {
    const d = await resolveDevice(s, ref);
    plan.devices.push({
      id: d.id,
      name: d.name,
      handle: d.legacySystemId ?? null,
    });
  }
  for (const ref of csv(str(ctx, "areas"))) {
    const a = await resolveArea(s, ref);
    plan.areas.push({ id: a.id!, name: a.displayName });
    if (bool(ctx, "cascade"))
      for (const m of await areaMemberDevices(s, a.id!)) {
        // 🛑 A `vendor: "helper"` member is server-managed (the battery-provenance writer mints it).
        // Transferring it would hand over a row the server considers its own, so cascade skips it.
        if (m.vendor === "helper") continue;
        if (plan.devices.some((x) => x.id === m.id)) continue;
        plan.devices.push({
          id: m.id,
          name: m.name,
          handle: m.legacySystemId ?? null,
        });
      }
  }
  for (const ref of csv(str(ctx, "dashboards"))) {
    const d = await resolveDashboard(s, ref);
    plan.dashboards.push({ id: d.id, name: d.name });
  }

  requireSomething(plan);

  // Which dashboards reference what is moving, that we are NOT moving? Listing them is the whole
  // reason cascade stops at devices.
  const moving = new Set<string>([
    ...plan.areas.map((a) => a.id),
    ...plan.devices.map((d) => d.id),
  ]);
  const named = new Set(plan.dashboards.map((d) => d.id));
  for (const d of await dashboardsReferencing(s, moving))
    if (!named.has(d.id))
      plan.referencingNotIncluded.push({ id: d.id, name: d.name });

  return plan;
}

async function runTransfer(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const toUserId = await resolveUserId(s, ctx.args[0]);
      const role = (str(ctx, "role") ?? "viewer") as "viewer" | "admin";

      if (bool(ctx, "noShareBack") && str(ctx, "shareBack") !== undefined)
        throw usage(
          "--share-back with --no-share-back",
          "they ask for opposite things",
          "drop one",
        );

      // Defaulting the share-back to YOU is the safe default: the overwhelmingly common intent is
      // "hand this over but keep seeing it", and the failure mode of the other default is silent
      // loss of access to your own site.
      const explicit = csv(str(ctx, "shareBack") ?? "");
      const shareBackRefs = bool(ctx, "noShareBack")
        ? []
        : explicit.length
          ? explicit
          : // "me", read from the token rather than assumed — the CLI can be signed in as someone
            // other than whoever is typing, and granting the wrong person back is silent.
            [(await s.get<{ userId: string }>("/api/cli-auth/whoami")).userId];
      const shareBackTo: string[] = [];
      for (const ref of shareBackRefs)
        shareBackTo.push(await resolveUserId(s, ref));

      const plan = await buildPlan(s, ctx);

      const body = {
        toUserId,
        devices: plan.devices.map((d) => d.id),
        areas: plan.areas.map((a) => a.id),
        dashboards: plan.dashboards.map((d) => d.id),
        shareBackTo,
        role,
        force: bool(ctx, "force"),
      };

      let result: WireTransferResult | null = null;
      if (!ctx.dryRun) {
        const { body: res } = await apiFetch<WireTransferResult>(
          s.origin,
          "/api/v4/ownership/transfer",
          { method: "POST", body, token: s.token, errors: TRANSFER_ERRORS },
        );
        result = res;
      }

      ctx.emit({ request: body, plan, applied: !ctx.dryRun, result }, () => {
        const out = [
          `${ctx.dryRun ? "would" : "WRITE"} transfer to ${ctx.args[0]} (${toUserId})`,
          "",
        ];
        for (const d of plan.devices)
          out.push(`  device     ${d.id}  ${d.name}`);
        for (const a of plan.areas) out.push(`  area       ${a.id}  ${a.name}`);
        for (const d of plan.dashboards)
          out.push(`  dashboard  ${d.id}  ${d.name ?? "(unnamed)"}`);
        out.push(
          "",
          shareBackTo.length
            ? `share back to ${shareBackTo.join(", ")} as ${role}, on ${plan.dashboards.length} dashboard(s)`
            : "🛑 NO share-back — only the new owner and platform admins will see these",
        );
        if (plan.referencingNotIncluded.length)
          out.push(
            "",
            `⚠️ ${plan.referencingNotIncluded.length} dashboard(s) reference what is moving but are NOT included:`,
            ...plan.referencingNotIncluded.map(
              (d) => `   ${d.id}  ${d.name ?? "(unnamed)"}`,
            ),
            "   Name them with --dashboards to move them too. The server refuses a transfer whose",
            "   share-back would not restore read access, so a needed one cannot be missed silently.",
          );
        if (result?.warnings.length)
          out.push("", ...result.warnings.map((w) => `⚠️ ${w}`));
        out.push(
          "",
          ctx.dryRun
            ? "Re-run with --apply to transfer."
            : `transferred ${result?.transferred.length ?? 0} object(s), wrote ${result?.grantsWritten.length ?? 0} grant(s).`,
        );
        return out.join("\n");
      });
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  show: runShow,
  transfer: runTransfer,
};

/** Run whichever `owner` verb was selected (the LAST path element under `liveone`). */
export async function runOwner(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown owner command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- owner --help`",
    );
  return handler(ctx);
}
