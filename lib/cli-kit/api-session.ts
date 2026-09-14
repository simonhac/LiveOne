/**
 * The shared HTTP session for CLI domains that speak ONLY to the deployed API.
 *
 * The dashboard domain carries a full transport seam because it has a second wire (direct
 * Postgres, for the unreadable-doc repair case). The read-only domains (`device`, `area`, `user`)
 * have no such case — their data is not even reachable by raw SQL without re-implementing the KV
 * latest cache, the history aggregation and the flow-matrix fold — so they get this thinner thing:
 * origin resolution, the stored `lo_cli_` token, and the same `target:` line, with no `--via` flag
 * to mislead anyone into thinking a db path exists.
 *
 * `printApiTarget` is ALSO the dashboard http transport's target line. One implementation on
 * purpose: the target line is the operator's only "which server, as whom" check, and two copies is
 * how one domain reports an identity the other doesn't.
 */
import { ADMIN_HEADER } from "@/lib/api-auth";
import { apiFetch, type ApiInit } from "@/lib/cli-kit/http";
import { requireToken, resolveOrigin } from "@/lib/cli-kit/target";
import { EXIT, failWith, type Ctx } from "@/lib/cli/cli";

export interface ApiSession {
  origin: string;
  token: string;
  /**
   * Whether this session ASKED to act as admin — `--admin` on the command line.
   *
   * 🛑 **Being an admin and using it are different, and the default is not using it.** An admin
   * running `liveone area list` is almost always looking at their own sites, and a CLI that silently
   * answered fleet-wide would make cross-owner reach the thing you get by not thinking about it.
   * `--admin` is one word, it is reported on the `target:` line, and it makes every fleet-wide answer
   * traceable to a request for one.
   *
   * False for a non-admin even with the flag: the server refuses (`actingAsAdmin` is gated on
   * `isAdmin`), and `withApiSession` refuses earlier with a usage error, so the flag cannot widen
   * anyone who is not already entitled.
   */
  actingAsAdmin: boolean;
  /**
   * The headers every request of this session must carry — today, `x-liveone-admin` when and only
   * when `--admin` was given and honoured.
   *
   * 🛑 The WRITE verbs call `apiFetch` directly rather than through `get`, so they do NOT carry this
   * unless they spread it — and today they deliberately do not need to. This PR's rule is that READS
   * are opt-in (`actingAsAdmin`) while WRITES keep the unconditional `isAdmin` they have always had,
   * so no write route consults the header. Spread it here when that changes; see
   * `docs/architecture/api.md`, which is where the whole write side converting is scoped.
   */
  headers: Record<string, string>;
  /** GET `path`, returning the parsed body. Non-2xx maps through `apiFetch`'s vocabulary. */
  get<T>(path: string, init?: Omit<ApiInit, "token" | "method">): Promise<T>;
}

/**
 * The `target:` line, to stderr, before any work — which deployment, as whom, against which
 * database, at which build. READ IT before trusting what a command reports: there is deliberately
 * no "am I on prod" auto-detection anywhere in the CLI; the printed identity is the check.
 *
 * Returns whether the caller is an ADMIN there, because it has just asked and the session needs the
 * answer (`ApiSession.isAdmin`). The alternative was a second `whoami` for a fact already on screen.
 */
export async function printApiTarget(
  origin: string,
  token: string,
  mode: string,
  askedForAdmin = false,
): Promise<boolean> {
  const { body: who } = await apiFetch<Record<string, unknown>>(
    origin,
    "/api/cli-auth/whoami",
    { token },
  );
  process.stderr.write(
    `target: ${origin} as ${who.email ?? who.userId}` +
      // 🛑 The distinction is the point: "(admin)" says you COULD, "(AS ADMIN)" says you ARE. An
      // operator reading this line has to be able to tell whether the answer below is fleet-wide.
      (who.isAdmin
        ? askedForAdmin
          ? " (AS ADMIN — fleet-wide)"
          : " (admin, not in use)"
        : "") +
      ` · ` +
      `clerk ${who.clerkInstance} · db ${who.dbHost} · build ${who.buildSha ?? "?"}   mode: ${mode}\n`,
  );
  if (
    mode === "APPLY" &&
    /\.vercel\.app$|\.preview\.liveone\.energy$/.test(new URL(origin).host)
  )
    process.stderr.write(
      "note: preview build — writes land in the dev database and are reverted by the prod→dev sync\n",
    );
  return who.isAdmin === true;
}

/**
 * Resolve the origin, require its token, print the target line, run `fn`.
 *
 * `mode` defaults to "read-only" because every current caller IS read-only; a future write verb
 * passes "dry-run"/"APPLY" exactly as the dashboard transport does.
 */
export async function withApiSession<T>(
  ctx: Ctx,
  fn: (s: ApiSession) => Promise<T>,
  mode = "read-only",
): Promise<T> {
  const origin = resolveOrigin(ctx);
  const entry = requireToken(origin, {
    why: "this command talks to the deployed API and needs a CLI token for the origin it calls",
  });
  // The target line goes FIRST, and it reports whether the flag was HONOURED rather than merely
  // passed — one `whoami`, printed before any work, reused as the entitlement check.
  const asked = ctx.flags.admin === true;
  const isAdmin = await printApiTarget(origin, entry.token, mode, asked);
  if (asked && !isAdmin)
    throw failWith(
      EXIT.AUTH,
      "--admin, but you are not an admin on this deployment",
      "the flag asks to exercise admin privilege, and this identity does not have it — the server would refuse it",
      "drop --admin, or check `liveone auth whoami` for which identity you are signed in as",
    );
  // 🛑 Sent ONLY when asked, and only when the ask was honoured. The server gates it on the caller
  // actually being an admin, so this is a request, not a claim.
  const headers: Record<string, string> =
    asked && isAdmin ? { [ADMIN_HEADER]: "1" } : {};
  const session: ApiSession = {
    origin,
    token: entry.token,
    actingAsAdmin: asked && isAdmin,
    headers,
    get: async <T>(
      path: string,
      init?: Omit<ApiInit, "token" | "method">,
    ): Promise<T> =>
      (
        await apiFetch<T>(origin, path, {
          ...init,
          token: entry.token,
          headers: { ...headers, ...init?.headers },
        })
      ).body,
  };
  return fn(session);
}
