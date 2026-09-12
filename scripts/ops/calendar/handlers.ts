/**
 * The `calendar` verbs.
 *
 * Http-only, for the same reason `automation` is: what makes a feed token safe (the owner check on
 * the area, the scoping of a revoke to the area that owns the token) is server-side, and a direct
 * write would mint a credential none of it had seen.
 */
import { EXIT, num, str, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { resolveArea, usage, type WireArea } from "../shared";

/** A token as the API serves it, with both URL forms already assembled server-side. */
interface WireCalendarToken {
  token: string;
  label: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
  https: string;
  webcal: string;
}

function tokensPath(area: WireArea): string {
  return `/api/v4/areas/${encodeURIComponent(area.id!)}/calendar-tokens`;
}

async function listTokens(
  s: ApiSession,
  area: WireArea,
): Promise<WireCalendarToken[]> {
  const { tokens } = await s.get<{ tokens: WireCalendarToken[] }>(
    tokensPath(area),
  );
  return tokens;
}

const iso = (ms: number | null) =>
  ms === null ? "—" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** Live, expired or revoked — the only thing a reader of this list actually wants to know. */
function state(t: WireCalendarToken, nowMs: number): string {
  if (t.revokedAtMs !== null) return `revoked ${iso(t.revokedAtMs)}`;
  if (t.expiresAtMs !== null && t.expiresAtMs <= nowMs)
    return `expired ${iso(t.expiresAtMs)}`;
  return t.expiresAtMs === null ? "live" : `live until ${iso(t.expiresAtMs)}`;
}

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const area = await resolveArea(s, ctx.args[0]);
    const tokens = await listTokens(s, area);
    const nowMs = Date.now();

    ctx.emit({ area: { id: area.id, name: area.displayName }, tokens }, () =>
      tokens.length === 0
        ? `${area.displayName} (${area.id}) has no calendar tokens. \`liveone calendar mint\` makes one.`
        : [
            `${tokens.length} calendar token${tokens.length === 1 ? "" : "s"} on ${area.displayName} (${area.id})`,
            ...tokens.flatMap((t) => [
              `  ${t.label}`,
              `    ${state(t, nowMs)}   minted ${iso(t.createdAtMs)}   last used ${iso(t.lastUsedAtMs)}`,
              `    ${t.webcal}`,
            ]),
          ].join("\n"),
    );
    return tokens.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

async function runMint(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const label = str(ctx, "label")!;
      const expiresDays = num(ctx, "expiresDays");
      const area = await resolveArea(s, ctx.args[0]);

      let minted: WireCalendarToken | undefined;
      if (!ctx.dryRun) {
        const { body } = await apiFetch<{ token: WireCalendarToken }>(
          s.origin,
          tokensPath(area),
          {
            method: "POST",
            body: { label, expiresInDays: expiresDays ?? null },
            token: s.token,
          },
        );
        minted = body.token;
      }

      ctx.emit(
        {
          area: { id: area.id, name: area.displayName },
          label,
          expiresInDays: expiresDays ?? null,
          applied: !ctx.dryRun,
          token: minted ?? null,
        },
        () =>
          [
            `${ctx.dryRun ? "would" : "WRITE"} mint a calendar feed token on ${area.displayName} (${area.id})`,
            `  label:        ${label}`,
            `  expires:      ${expiresDays === undefined ? "never" : `in ${expiresDays} days`}`,
            "  🛑 the URL below IS the credential — anyone holding it can read this area's schedule",
            ...(minted
              ? [
                  "",
                  "subscribe (calendar app):",
                  `  ${minted.webcal}`,
                  "fetch (curl, one-off import):",
                  `  ${minted.https}`,
                  "",
                  "It is shown once here, and again in `liveone calendar list`.",
                ]
              : ["Re-run with --apply to mint it."]),
          ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function runRevoke(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const area = await resolveArea(s, ctx.args[0]);
      const ref = ctx.args[1];
      const tokens = await listTokens(s, area);

      // By token or by label, and only among the LIVE ones — revoking an already-revoked token is
      // a no-op the operator should be told about rather than a second success.
      const live = tokens.filter(
        (t) =>
          t.revokedAtMs === null &&
          (t.expiresAtMs === null || t.expiresAtMs > Date.now()),
      );
      const matches = live.filter(
        (t) => t.token === ref || t.label.toLowerCase() === ref.toLowerCase(),
      );

      if (matches.length === 0) {
        ctx.emit({ area: { id: area.id }, ref, applied: false }, () =>
          [
            `No live calendar token on ${area.displayName} matches "${ref}".`,
            `Run \`liveone calendar list ${area.id}\` to see them.`,
          ].join("\n"),
        );
        return EXIT.FINDINGS;
      }
      if (matches.length > 1)
        throw usage(
          `"${ref}" matches ${matches.length} live tokens`,
          "two tokens share that label, so revoking by it would pick one arbitrarily",
          `pass the token itself — \`liveone calendar list ${area.id}\` prints them`,
        );

      const target = matches[0];
      if (!ctx.dryRun)
        await apiFetch(
          s.origin,
          `${tokensPath(area)}?token=${encodeURIComponent(target.token)}`,
          { method: "DELETE", token: s.token },
        );

      ctx.emit({ token: target, applied: !ctx.dryRun }, () =>
        [
          `${ctx.dryRun ? "would" : "WRITE"} revoke "${target.label}" on ${area.displayName}`,
          "  the subscriber's calendar stops updating, usually without saying so",
          ctx.dryRun
            ? "Re-run with --apply to revoke it. There is no un-revoke."
            : "revoked.",
        ].join("\n"),
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  mint: runMint,
  revoke: runRevoke,
};

/** Run whichever `calendar` verb was selected (the LAST path element under `liveone`). */
export async function runCalendar(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown calendar command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- calendar --help`",
    );
  return handler(ctx);
}
