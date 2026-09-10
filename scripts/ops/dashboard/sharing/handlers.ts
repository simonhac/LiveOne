/**
 * The sharing verbs.
 *
 * 🛑 `PUT …/grants` is a DECLARATIVE FULL REPLACE — `{members: []}` revokes everyone. `add` and
 * `remove` are therefore read-modify-write, and every write prints a diff whose *kept* count is the
 * assertion that nothing was silently evicted. Only `set` sends the caller's list verbatim, and it
 * says so in its own summary.
 */
import { EXIT, num, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { str, usage } from "../../shared";
import { resolveUserId } from "../../user/cli";

type Role = "viewer" | "admin";

interface WireMember {
  clerkUserId: string;
  role: string;
  email?: string | null;
  name?: string | null;
}

interface WireToken {
  token: string;
  label: string | null;
  createdAtMs: number | null;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

interface WireDash {
  id: string;
  name: string | null;
  slug: string | null;
}

export const SHARE_ERRORS = {
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this change",
    why: (b: Record<string, unknown>) => {
      const errs = b.errors;
      if (Array.isArray(errs) && errs.length)
        return errs
          .map((e) =>
            typeof e === "object" && e
              ? String((e as Record<string, unknown>).code ?? JSON.stringify(e))
              : String(e),
          )
          .join("; ");
      return String(b.error ?? "refused");
    },
    // Validation is all-or-nothing and runs before the transaction, so this is always true.
    next: "nothing changed — one unresolvable invitee fails the whole call",
  },
  403: {
    exit: EXIT.FINDINGS,
    what: "not your dashboard",
    why: (b: Record<string, unknown>) => String(b.error ?? "forbidden"),
    next: "grants and links are owner-or-admin; check `liveone auth whoami`",
  },
  // The referential-integrity refusal (lib/integrity). Handled HERE rather than falling through to
  // the shared 409 case, which is written for a slug collision and would advise "pick a different
  // slug" — advice that is not merely unhelpful but points at the wrong field entirely. It also
  // drops `detail.dependents`, which is the only part of the refusal worth reading.
  409: {
    exit: EXIT.FINDINGS,
    what: "something still relies on this dashboard",
    why: (b: Record<string, unknown>) => {
      const detail = b.detail as Record<string, unknown> | undefined;
      const deps = detail?.dependents;
      if (!Array.isArray(deps) || deps.length === 0)
        return String(b.error ?? "conflict");
      return deps
        .map((d) => {
          const x = d as Record<string, unknown>;
          const name = x.name ? ` ${String(x.name)}` : "";
          return `  ${String(x.kind)}${name} (${String(x.id)}) — via ${String(x.via)}, ${String(x.effect)}`;
        })
        .join("\n");
    },
    next: "resolve them, or re-run with --force to proceed anyway — nothing was written",
  },
} as const;

async function resolveDash(s: ApiSession, ref: string): Promise<WireDash> {
  const { dashboards } = await s.get<{ dashboards: WireDash[] }>(
    "/api/v4/dashboards",
  );
  const hit = dashboards.find(
    (d) => d.id === ref || d.slug === ref || d.name === ref,
  );
  if (!hit)
    throw usage(
      `no dashboard matches "${ref}"`,
      "nothing you can access has that id, slug or name",
      "run `liveone dashboard list` — ids are per-environment",
    );
  return hit;
}

const label = (m: WireMember) =>
  `${(m.email ?? m.clerkUserId).padEnd(34)} ${m.role}`;

function diff(before: string[], after: string[]): string[] {
  const kept = after.filter((x) => before.includes(x));
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  return [
    `members: ${before.length} → ${after.length}  (${kept.length} kept, ${added.length} added, ${removed.length} removed)`,
    ...added.map((x) => `   + ${x}`),
    ...removed.map((x) => `   - ${x}`),
    ...(added.length || removed.length ? [] : ["   (no change)"]),
  ];
}

async function getMembers(s: ApiSession, id: string): Promise<WireMember[]> {
  const body = await s.get<{ members: WireMember[] }>(
    `/api/v4/dashboards/${encodeURIComponent(id)}/grants`,
  );
  return body.members ?? [];
}

async function runShareList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const d = await resolveDash(s, ctx.args[0]);
    const members = await getMembers(s, d.id);
    ctx.emit({ dashboard: d, members }, () =>
      [
        `${d.name ?? d.slug ?? d.id} (${d.id})`,
        "",
        ...members.map((m) => `  ${label(m)}`),
        "",
        members.length
          ? `${members.length} member(s). The owner is not listed — ownership is not a grant.`
          : "No members. Only the owner and platform admins can see this.",
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

function membershipWriter(mode: "add" | "remove" | "set") {
  return async (ctx: Ctx): Promise<number> =>
    withApiSession(
      ctx,
      async (s) => {
        const d = await resolveDash(s, ctx.args[0]);
        const role = (str(ctx, "role") ?? "viewer") as Role;
        const current = await getMembers(s, d.id);

        const named: string[] = [];
        for (const ref of ctx.args.slice(1))
          named.push(await resolveUserId(s, ref));

        let target: Array<{ clerkUserId: string; role: Role }>;
        if (mode === "add") {
          const byId = new Map(
            current.map((m) => [m.clerkUserId, m.role as Role]),
          );
          for (const id of named) byId.set(id, role);
          target = [...byId].map(([clerkUserId, r]) => ({
            clerkUserId,
            role: r,
          }));
        } else if (mode === "remove") {
          target = current
            .filter((m) => !named.includes(m.clerkUserId))
            .map((m) => ({ clerkUserId: m.clerkUserId, role: m.role as Role }));
        } else {
          target = named.map((clerkUserId) => ({ clerkUserId, role }));
        }

        const idToLabel = new Map(
          current.map((m) => [m.clerkUserId, m.email ?? m.clerkUserId]),
        );
        const show = (x: { clerkUserId: string; role: Role }) =>
          `${idToLabel.get(x.clerkUserId) ?? x.clerkUserId} (${x.role})`;
        const lines = diff(
          current.map((m) =>
            show({ clerkUserId: m.clerkUserId, role: m.role as Role }),
          ),
          target.map(show),
        );

        let members: WireMember[] | null = null;
        if (!ctx.dryRun) {
          const { body } = await apiFetch<{ members: WireMember[] }>(
            s.origin,
            `/api/v4/dashboards/${encodeURIComponent(d.id)}/grants`,
            {
              method: "PUT",
              body: { members: target },
              token: s.token,
              errors: SHARE_ERRORS,
            },
          );
          members = body.members;
        }

        ctx.emit(
          {
            dashboard: d,
            before: current,
            after: target,
            applied: !ctx.dryRun,
            members,
          },
          () =>
            [
              `${ctx.dryRun ? "would" : "WRITE"} share ${mode} on ${d.name ?? d.id}`,
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

const when = (ms: number | null) =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—";

async function runLinkList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const d = await resolveDash(s, ctx.args[0]);
    const { tokens } = await s.get<{ tokens: WireToken[] }>(
      `/api/v4/dashboards/${encodeURIComponent(d.id)}/shares`,
    );
    ctx.emit({ dashboard: d, tokens }, () =>
      [
        `${d.name ?? d.id} (${d.id})`,
        "",
        "token                 label                created           expires            last used          state",
        ...tokens.map((t) =>
          [
            t.token.padEnd(21),
            (t.label ?? "—").slice(0, 20).padEnd(20),
            when(t.createdAtMs).padEnd(18),
            when(t.expiresAtMs).padEnd(18),
            when(t.lastUsedAtMs).padEnd(18),
            t.revokedAtMs ? "REVOKED" : "live",
          ].join(" "),
        ),
        "",
        `${tokens.length} link(s); ${tokens.filter((t) => !t.revokedAtMs).length} live.`,
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runLinkCreate(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const d = await resolveDash(s, ctx.args[0]);
      const body = {
        ...(str(ctx, "label") !== undefined
          ? { label: str(ctx, "label") }
          : {}),
        ...(num(ctx, "expiresInDays") !== undefined
          ? { expiresInDays: num(ctx, "expiresInDays") }
          : {}),
      };
      let token: WireToken | null = null;
      if (!ctx.dryRun) {
        const { body: res } = await apiFetch<WireToken>(
          s.origin,
          `/api/v4/dashboards/${encodeURIComponent(d.id)}/shares`,
          { method: "POST", body, token: s.token, errors: SHARE_ERRORS },
        );
        token = res;
      }
      ctx.emit(
        { dashboard: d, request: body, applied: !ctx.dryRun, token },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} mint a share link on ${d.name ?? d.id}`,
            `  label    ${str(ctx, "label") ?? "(none)"}`,
            `  expires  ${num(ctx, "expiresInDays") ? `in ${num(ctx, "expiresInDays")} day(s)` : "never"}`,
            "",
            token
              ? `token ${token.token}\n🛑 Anyone with this can read the dashboard WITHOUT signing in.`
              : "Re-run with --apply to mint it.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runLinkRevoke(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const d = await resolveDash(s, ctx.args[0]);
      const tok = ctx.args[1];
      let result: Record<string, unknown> | null = null;
      if (!ctx.dryRun) {
        const { body } = await apiFetch<Record<string, unknown>>(
          s.origin,
          `/api/v4/dashboards/${encodeURIComponent(d.id)}/shares?token=${encodeURIComponent(tok)}`,
          { method: "DELETE", token: s.token, errors: SHARE_ERRORS },
        );
        result = body;
      }
      ctx.emit({ dashboard: d, token: tok, applied: !ctx.dryRun, result }, () =>
        [
          `${ctx.dryRun ? "would" : "WRITE"} revoke ${tok} on ${d.name ?? d.id}`,
          "",
          ctx.dryRun ? "Re-run with --apply to revoke." : "revoked.",
        ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/**
 * Delete a dashboard, having first said what the cascade will take.
 *
 * 🛑 The point of this verb over a bare API call is the inventory. `DELETE /dashboards/{id}` returns
 * `{success:true}` and says nothing about the grants and LIVE SHARE TOKENS that went with it —
 * `share_tokens` and `dashboard_grants` both cascade from `dashboards.id`. A link someone is still
 * using dies here, and the only chance to notice is before.
 */
async function runDelete(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const d = await resolveDash(s, ctx.args[0]);
      const [members, links, full] = await Promise.all([
        getMembers(s, d.id),
        s.get<{ tokens: WireToken[] }>(
          `/api/v4/dashboards/${encodeURIComponent(d.id)}/shares`,
        ),
        s.get<{ revision?: number; doc?: unknown }>(
          `/api/v4/dashboards/${encodeURIComponent(d.id)}`,
        ),
      ]);
      const live = links.tokens.filter((t) => !t.revokedAtMs);

      // 🛑 Whose LANDING is this? `users.default_dashboard_id` DOES have an FK — `ON DELETE SET
      // NULL` — which is precisely why this check earns its keep: the constraint guarantees the
      // column never dangles, and that is the whole problem. The preference is silently emptied and
      // the owner simply lands somewhere else next time, with nothing to connect it to a deletion
      // made days earlier. Cheap to check (the directory is small), impossible to notice afterwards.
      const landsHere: string[] = [];
      try {
        const { users } = await s.get<{
          users: Array<{ clerkUserId: string; email?: string }>;
        }>("/api/v4/users");
        for (const u of users) {
          const one = await s.get<{ defaultDashboardId?: string | null }>(
            `/api/v4/users/${encodeURIComponent(u.clerkUserId)}`,
          );
          if (one.defaultDashboardId === d.id)
            landsHere.push(u.email ?? u.clerkUserId);
        }
      } catch {
        // Non-admin tokens cannot read the directory. Say so rather than implying "nobody".
        landsHere.push("(could not check — directory is admin-only)");
      }

      // 🛑 `?force=true` — and the dry run above is what earns it. The server's gate refuses while
      // grants, live links or a landing preference exist; this command has just ENUMERATED all
      // three by name and printed them, and `--apply` is the operator's answer to that list. Making
      // them type a second flag to confirm a list they were shown by the same command would be
      // ceremony, not consent. The force is visible in the emitted record either way.
      if (!ctx.dryRun)
        await apiFetch<{ success: boolean }>(
          s.origin,
          `/api/v4/dashboards/${encodeURIComponent(d.id)}?force=true`,
          { method: "DELETE", token: s.token, errors: SHARE_ERRORS },
        );

      ctx.emit(
        {
          dashboard: d,
          revision: full.revision ?? null,
          grantsDestroyed: members,
          linksDestroyed: links.tokens,
          liveLinksDestroyed: live,
          usersLandingHere: landsHere,
          applied: !ctx.dryRun,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} DELETE ${d.name ?? d.slug ?? d.id} (${d.id})`,
            `  revision ${full.revision ?? "?"} — the whole edit history goes with it`,
            "",
            `  ${members.length} grant(s) revoked:`,
            ...members.map(
              (m) => `     ${m.email ?? m.clerkUserId} (${m.role})`,
            ),
            `  ${links.tokens.length} share link(s) destroyed, ${live.length} of them LIVE:`,
            ...links.tokens.map(
              (t) =>
                `     ${t.token}  ${t.label ?? "(no label)"}  last used ${when(t.lastUsedAtMs)}` +
                (t.revokedAtMs ? "  (already revoked)" : "  ← LIVE"),
            ),
            ...(landsHere.length
              ? [
                  "",
                  `  🛑 ${landsHere.length} user(s) land HERE by default and would be left dangling:`,
                  ...landsHere.map((u) => `     ${u}`),
                ]
              : []),
            "",
            ctx.dryRun
              ? "🛑 IRREVERSIBLE. Re-run with --apply to delete."
              : "deleted.",
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

/** Keyed by the FULL path under `dashboard`: `share list` and `link list` share a last element. */
export const SHARING_HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  "share.list": runShareList,
  "share.add": membershipWriter("add"),
  "share.remove": membershipWriter("remove"),
  "share.set": membershipWriter("set"),
  "link.list": runLinkList,
  "link.create": runLinkCreate,
  "link.revoke": runLinkRevoke,
  delete: runDelete,
};
