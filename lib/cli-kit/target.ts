/**
 * Which server the CLI is about to talk to, and as whom.
 *
 * This is ONE decision with ONE implementation on purpose. It was briefly two — the `auth` domain
 * and the dashboard transport each resolved the origin themselves — and two copies of "which
 * server am I writing to" is the seam where `auth login` stores a token for one host while
 * `dashboard set-prop --apply` writes to another. There is no safe divergence here, so there is no
 * second copy.
 */
import { EXIT, failWith, type Ctx } from "@/lib/cli/cli";
import {
  DEFAULT_STORE_PATH,
  normalizeOrigin,
  readStore,
  tokenFor,
  type StoredToken,
} from "@/lib/cli-kit/token-store";

/**
 * The default target. WWW deliberately, never the apex: the apex 307-redirects, and undici strips
 * `Authorization` on cross-origin redirects — following it would turn every call into a mystery
 * 401. `apiFetch` refuses a redirect rather than following it, for the same reason.
 */
export const DEFAULT_ORIGIN = "https://www.liveone.energy";

/**
 * Precedence: `--base-url` > `LIVEONE_BASE_URL` > the store's remembered default > prod.
 *
 * The store's default is what makes a laptop that logged into dev stay on dev without repeating
 * the flag — and what makes it worth printing the resolved target on stderr before any write.
 *
 * `useStoredDefault: false` is for `auth login` alone: a bare `login` should mean PROD, not
 * "wherever I happened to log in last". Every other command wants the sticky behaviour, so the
 * exception is a named argument here rather than a second resolver over there.
 */
export function resolveOrigin(
  ctx: Ctx,
  opts: { useStoredDefault?: boolean; storePath?: string } = {},
): string {
  const flag = ctx.flags.baseUrl as string | undefined;
  if (flag) return normalizeOrigin(flag);
  const env = process.env.LIVEONE_BASE_URL;
  if (env) return normalizeOrigin(env);
  const stored =
    opts.useStoredDefault === false
      ? undefined
      : readStore(opts.storePath ?? DEFAULT_STORE_PATH).defaultOrigin;
  return normalizeOrigin(stored ?? DEFAULT_ORIGIN);
}

/**
 * The stored bearer for `origin`, or a clean exit-3 saying how to get one.
 *
 * `why` lets a caller explain what specifically needed the token — the dashboard transport adds
 * that `--via=db` is the alternative, which is not true of the auth verbs.
 */
export function requireToken(
  origin: string,
  detail?: { why?: string; alsoTry?: string; storePath?: string },
): StoredToken {
  const entry = tokenFor(origin, detail?.storePath ?? DEFAULT_STORE_PATH);
  if (!entry)
    throw failWith(
      EXIT.AUTH,
      `not logged in to ${origin}`,
      detail?.why ?? "there is no stored CLI token for that origin",
      `run \`liveone auth login --base-url=${origin}\`${detail?.alsoTry ? ` ${detail.alsoTry}` : ""}`,
    );
  return entry;
}
