/**
 * Recognising a CLI credential in an `Authorization` header.
 *
 * 🛑 DELIBERATELY CRYPTO-FREE, and deliberately not part of `./tokens.ts`. `middleware.ts` runs on
 * the EDGE runtime and imports this (via `lib/route-matchers.ts`) to decide whether to let a
 * request past `auth.protect()`. `tokens.ts` uses `node:crypto` (`createHash`, `timingSafeEqual`)
 * for the verification itself, and pulling that into the edge bundle is both unnecessary and not
 * reliably supported there. So: string work here, secrets work there.
 *
 * This module answers only "is a CLI credential being PRESENTED, and what is it" — never "is it
 * valid". Validity is `lib/cli-auth/verify.ts`, called from the route handler.
 */

export const TOKEN_PREFIX = "lo_cli_";

/**
 * The presented CLI token, or `null`.
 *
 * Returns the token rather than a boolean plus a slice at the call site: a hand-written
 * `header.slice(7)` is silently wrong the moment the scheme arrives as `bearer` with two spaces,
 * and it would then fail to verify a perfectly good credential. One extraction, one behaviour.
 *
 * Scheme matching is case-insensitive because RFC 7235 says the scheme is; the `lo_cli_` prefix is
 * exact.
 */
export function cliBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = /^(\S+)\s+(.*)$/.exec(header.trim());
  if (!m || m[1].toLowerCase() !== "bearer") return null;
  const token = m[2].trim();
  return token.startsWith(TOKEN_PREFIX) ? token : null;
}

/** Presence-only. The token is NOT validated here — see the module note. */
export function hasCliBearer(request: Request): boolean {
  return cliBearerToken(request) !== null;
}
