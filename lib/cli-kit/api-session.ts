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
import { apiFetch, type ApiInit } from "@/lib/cli-kit/http";
import { requireToken, resolveOrigin } from "@/lib/cli-kit/target";
import type { Ctx } from "@/lib/cli/cli";

export interface ApiSession {
  origin: string;
  token: string;
  /** GET `path`, returning the parsed body. Non-2xx maps through `apiFetch`'s vocabulary. */
  get<T>(path: string, init?: Omit<ApiInit, "token" | "method">): Promise<T>;
}

/**
 * The `target:` line, to stderr, before any work — which deployment, as whom, against which
 * database, at which build. READ IT before trusting what a command reports: there is deliberately
 * no "am I on prod" auto-detection anywhere in the CLI; the printed identity is the check.
 */
export async function printApiTarget(
  origin: string,
  token: string,
  mode: string,
): Promise<void> {
  const { body: who } = await apiFetch<Record<string, unknown>>(
    origin,
    "/api/cli-auth/whoami",
    { token },
  );
  process.stderr.write(
    `target: ${origin} as ${who.email ?? who.userId}${who.isAdmin ? " (admin)" : ""} · ` +
      `clerk ${who.clerkInstance} · db ${who.dbHost} · build ${who.buildSha ?? "?"}   mode: ${mode}\n`,
  );
  if (
    mode === "APPLY" &&
    /\.vercel\.app$|\.preview\.liveone\.energy$/.test(new URL(origin).host)
  )
    process.stderr.write(
      "note: preview build — writes land in the dev database and are reverted by the prod→dev sync\n",
    );
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
  const session: ApiSession = {
    origin,
    token: entry.token,
    get: async <T>(
      path: string,
      init?: Omit<ApiInit, "token" | "method">,
    ): Promise<T> =>
      (await apiFetch<T>(origin, path, { ...init, token: entry.token })).body,
  };
  await printApiTarget(origin, entry.token, mode);
  return fn(session);
}
