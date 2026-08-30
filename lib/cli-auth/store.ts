/**
 * Persisting CLI token records to Clerk private metadata — the only module that WRITES them.
 *
 * Kept apart from `./tokens.ts` (pure) and `./verify.ts` (read path) so there is exactly one place
 * that can change a user's credential set, and so the pure logic stays testable without Clerk.
 *
 * 🛑 `updateUserMetadata` REPLACES the top-level keys it is given. It merges at the top level only,
 * so passing `{ privateMetadata: { cliTokens } }` leaves `version`/`credentials` (the vendor
 * credentials `lib/secure-credentials.ts` owns) untouched — but passing a nested object would
 * clobber whatever else lived under that same key. Only ever write the one key.
 */
import { clerkClient } from "@clerk/nextjs/server";
import {
  mintToken,
  revokeToken,
  recordsOf,
  shouldTouch,
  METADATA_KEY,
  type CliTokenRecord,
  type UserLike,
} from "./tokens";

async function writeRecords(
  userId: string,
  records: CliTokenRecord[],
): Promise<void> {
  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, {
    privateMetadata: { [METADATA_KEY]: records },
  });
}

async function getUser(userId: string): Promise<UserLike> {
  const client = await clerkClient();
  return (await client.users.getUser(userId)) as unknown as UserLike;
}

/** Mint a token for `userId` and persist it. Returns the secret — shown to the operator ONCE. */
export async function issueToken(
  userId: string,
  opts: { label: string; ttlDays?: number; now?: Date },
): Promise<{ token: string; record: CliTokenRecord }> {
  const now = opts.now ?? new Date();
  const user = await getUser(userId);
  const { token, record, records } = mintToken(user, { ...opts, now });
  await writeRecords(userId, records);
  return { token, record };
}

/** Revoke one token by id, or all of them. Returns how many were newly revoked. */
export async function revoke(
  userId: string,
  opts: { id?: string; all?: boolean; now?: Date },
): Promise<number> {
  const now = opts.now ?? new Date();
  const user = await getUser(userId);
  const { records, revoked } = revokeToken(user, { ...opts, now });
  // Skip the write when nothing changed: revoking an already-revoked token is idempotent, and a
  // no-op write would still cost a Clerk round trip.
  if (revoked > 0) await writeRecords(userId, records);
  return revoked;
}

/**
 * Record that a token was used — throttled, and deliberately fire-and-forget.
 *
 * `lastUsedAt` is diagnostic. Awaiting a Clerk write on every authenticated CLI request would put
 * a network round trip on the request path to record something nobody reads at that resolution, so
 * this is called without `await` and swallows its own failures.
 */
export function touchToken(
  userId: string,
  recordId: string,
  now = new Date(),
): void {
  void (async () => {
    try {
      const user = await getUser(userId);
      const records = recordsOf(user);
      const hit = records.find((r) => r.id === recordId);
      if (!hit || !shouldTouch(hit, now)) return;
      await writeRecords(
        userId,
        records.map((r) =>
          r.id === recordId ? { ...r, lastUsedAt: now.toISOString() } : r,
        ),
      );
    } catch {
      // A failed bookkeeping write must never affect the request that triggered it.
    }
  })();
}
