/**
 * Resolving a presented `lo_cli_` token to a Clerk user — the one impure step, kept apart from the
 * pure logic in `./tokens.ts` so that logic stays testable without a network.
 *
 * 🛑 THIS IS AUTHENTICATION. Every failure path must return `null`, and the caller must treat
 * `null` as "no user" and STOP — never fall through to another mechanism. The distinctions the
 * verifier draws internally (unknown secret vs expired vs revoked) are for the server's own
 * reasoning; the caller reports one undifferentiated 401, or the response would tell an attacker
 * which half of a guess was right.
 */
import { clerkClient } from "@clerk/nextjs/server";
import { parseToken, verifyToken, type CliTokenRecord } from "./tokens";

export interface VerifiedCliToken {
  userId: string;
  /** Read from the SAME user record the verification used, so the admin check costs no second call. */
  isAdmin: boolean;
  record: CliTokenRecord;
}

/**
 * Verify a bearer value. Returns `null` for anything that is not a currently-valid CLI token.
 *
 * `now` is injectable so a test can drive expiry without waiting.
 */
export async function verifyCliToken(
  raw: string,
  now: Date = new Date(),
): Promise<VerifiedCliToken | null> {
  const parsed = parseToken(raw);
  if (!parsed) return null;

  let user;
  try {
    const client = await clerkClient();
    user = await client.users.getUser(parsed.userId);
  } catch {
    // An unknown user id, or Clerk being unreachable, is not an authenticated request. Deliberately
    // indistinguishable from a bad secret in what the caller can observe.
    return null;
  }
  if (!user) return null;

  const result = verifyToken(raw, user, now);
  if (!result.ok) return null;

  // The admin flag comes off the record already in hand. `isUserAdmin` would otherwise make a
  // SECOND Clerk call for a fact this response already contains — and on the CLI path there is no
  // session claim to short-circuit it.
  const isAdmin =
    (user.publicMetadata as { isPlatformAdmin?: unknown } | null)
      ?.isPlatformAdmin === true;

  return { userId: user.id, isAdmin, record: result.record };
}
