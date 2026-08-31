/**
 * Overlap guard for the `* * * * *` crons.
 *
 * `vercel.json` gives `/api/cron/minutely` a `maxDuration` of 60 s — exactly its period — and
 * nothing prevented a run that overshot from being joined by the next one. Measured on prod: 38
 * minutes in 24 h where a device was polled twice, all downstream of a single vendor stalling.
 * Double-polling isn't corrupting (sessions are per-device, the observations receiver is idempotent)
 * but it doubles the vendor API spend and makes the cadence unmeasurable — a device polled twice a
 * minute is indistinguishable, after the fact, from a device on a tighter schedule.
 *
 * **Why a KV lease and not a Postgres advisory lock.** `pg_try_advisory_lock` is session-scoped, and
 * we reach Postgres through a `pg.Pool`: the lock would be taken on whichever pooled connection
 * served the query and the matching unlock could easily run on a different one, leaking the lock
 * until that connection recycled. Holding it transaction-scoped instead would mean an open
 * transaction for the whole run. A KV key with a TTL has neither problem, needs no connection, and
 * self-heals if the function is killed mid-run.
 */

import { kv, kvKey } from "@/lib/kv";

/** Long enough to cover a full 60 s run plus the kill margin; short enough to self-heal fast. */
const LEASE_TTL_SEC = 90;

export interface CronLease {
  release: () => Promise<void>;
}

/**
 * Try to take the named cron's lease. Returns `null` if another run holds it.
 *
 * Fails OPEN — an unconfigured or unreachable KV yields a lease that does nothing. A polling outage
 * is a worse failure than a double poll, and `lib/kv.ts` already degrades to no-ops rather than
 * throwing when credentials are absent.
 */
export async function acquireCronLease(
  name: string,
  holder: string,
): Promise<CronLease | null> {
  // Decide "is locking available" from the CREDENTIALS, not from the return value.
  // `SET … NX` answers null when the key already exists — i.e. exactly when another run holds the
  // lease — and `lib/kv.ts`'s no-op proxy (KV unconfigured) also resolves to null. Reading null as
  // "no KV, proceed unlocked" therefore disables the lock in the one case it exists for.
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return { release: async () => {} };
  }

  const key = kvKey(`cron:lease:${name}`);
  try {
    const ok = await kv.set(key, holder, { nx: true, ex: LEASE_TTL_SEC });
    if (ok !== "OK") return null; // held by another run
  } catch (e) {
    console.error(
      `[cron-lease] could not acquire '${name}' (proceeding unlocked):`,
      e instanceof Error ? e.message : e,
    );
    return { release: async () => {} };
  }

  return {
    release: async () => {
      try {
        // Only clear OUR lease: if this run overran its TTL and a later run took over, deleting the
        // key blindly would hand a third run a lease the second one still thinks it holds.
        const current = await kv.get<string>(key);
        if (current === holder) await kv.del(key);
      } catch (e) {
        console.error(
          `[cron-lease] release of '${name}' failed (TTL will clear it):`,
          e instanceof Error ? e.message : e,
        );
      }
    },
  };
}

/**
 * Who currently holds the named lease, or null if nobody (or KV is unconfigured).
 *
 * Diagnostic only — never gates a poll. A skipped tick and a tick Vercel simply never delivered are
 * indistinguishable in the logs otherwise, and they have different remedies: an overlap means a run
 * overshot its 60 s period, delivery jitter means it did not. The slot scheduler no longer LOSES a
 * slot to either (`lib/vendors/schedule.ts` keeps a slot due until it has actually been attempted),
 * so this is for telling the two apart, not for damage control.
 */
export async function readCronLeaseHolder(
  name: string,
): Promise<string | null> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return null;
  }
  try {
    return (await kv.get<string>(kvKey(`cron:lease:${name}`))) ?? null;
  } catch {
    return null;
  }
}
