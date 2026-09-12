/**
 * Feed tokens for an area's subscribable automation calendar.
 *
 * Modelled on `lib/dashboard/sharing.ts` — mint / validate / list / revoke, `last_used_at` touched
 * fire-and-forget — but deliberately a separate table and a separate predicate. A dashboard share
 * token grants read access to the POINTS a dashboard exposes, resolved per request against that
 * dashboard's contents; this grants exactly one thing, "what is scheduled on this area", and
 * nothing else. Making one stand in for the other would mean a calendar subscription carrying data
 * access, or a share link carrying a schedule.
 */
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { areaCalendarTokens } from "@/lib/db/planetscale/schema";

/**
 * Crockford-ish base32 without the vowels, so a token cannot accidentally spell anything and
 * cannot be misread between 0/O or 1/I when someone reads a URL aloud.
 */
const ALPHABET = "0123456789bcdfghjkmnpqrstvwxyz";
const TOKEN_LENGTH = 20;
const TOKEN_RE = new RegExp(`^[${ALPHABET}]{${TOKEN_LENGTH}}$`);

/**
 * A fresh feed token.
 *
 * 🛑 `randomBytes`, never `Math.random()`. The URL is the whole credential, it is handed to a
 * calendar client that will re-fetch it hourly for years, and nothing about that traffic looks
 * anomalous — so guessability is the only property protecting it. 20 chars of this alphabet is
 * ~98 bits. The modulo bias is negligible at 256 % 30, and irrelevant at this width.
 */
function generateToken(): string {
  const bytes = randomBytes(TOKEN_LENGTH);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Cheap shape check, so a junk token costs no query — the `isWellFormedToken` precedent. */
function isWellFormedCalendarToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export interface CalendarTokenRow {
  token: string;
  label: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

function toRow(row: {
  token: string;
  label: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}): CalendarTokenRow {
  return {
    token: row.token,
    label: row.label,
    createdAtMs: row.createdAt.getTime(),
    expiresAtMs: row.expiresAt?.getTime() ?? null,
    revokedAtMs: row.revokedAt?.getTime() ?? null,
    lastUsedAtMs: row.lastUsedAt?.getTime() ?? null,
  };
}

/** Mint a feed token for an area. The raw uuid is the caller's — routes decode `ar_` first. */
export async function mintCalendarToken(opts: {
  areaUuid: string;
  label: string;
  expiresInDays?: number | null;
}): Promise<CalendarTokenRow> {
  const expiresAt =
    opts.expiresInDays && opts.expiresInDays > 0
      ? new Date(Date.now() + opts.expiresInDays * 86_400_000)
      : null;
  // No collision-retry loop, unlike `createDashboardShareToken`: at ~98 bits a PK collision is not
  // a case that happens, and a retry that never runs is a retry nobody would notice was broken.
  const [row] = await requirePlanetscaleDb()
    .insert(areaCalendarTokens)
    .values({
      token: generateToken(),
      areaId: opts.areaUuid,
      label: opts.label,
      expiresAt,
    })
    .returning();
  return toRow(row);
}

/**
 * Well-formed, not revoked, not expired → the area it grants.
 *
 * Returns the AREA rather than a boolean so the caller can check the token belongs to the area it
 * was presented against; a route that only asked "is this token valid" would let any area's token
 * read any other area's feed.
 */
export async function validateCalendarToken(
  token: string,
): Promise<{ areaUuid: string } | null> {
  if (!isWellFormedCalendarToken(token)) return null;
  const pg = requirePlanetscaleDb();
  const [row] = await pg
    .select({ areaId: areaCalendarTokens.areaId })
    .from(areaCalendarTokens)
    .where(
      and(
        eq(areaCalendarTokens.token, token),
        isNull(areaCalendarTokens.revokedAt),
        or(
          isNull(areaCalendarTokens.expiresAt),
          gt(areaCalendarTokens.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);
  if (!row) return null;

  // Fire and forget: last-used is how a stale subscription is spotted, and it must never be able
  // to fail a feed the client is otherwise entitled to.
  void pg
    .update(areaCalendarTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(areaCalendarTokens.token, token))
    .catch(() => {});

  return { areaUuid: row.areaId };
}

/** Every token ever minted for an area, newest first — revoked and expired ones included. */
export async function listCalendarTokens(
  areaUuid: string,
): Promise<CalendarTokenRow[]> {
  const rows = await requirePlanetscaleDb()
    .select()
    .from(areaCalendarTokens)
    .where(eq(areaCalendarTokens.areaId, areaUuid))
    .orderBy(desc(areaCalendarTokens.createdAt));
  return rows.map(toRow);
}

/**
 * Revoke a token, scoped to the area that owns it.
 *
 * Idempotent, and the `areaId` term is load-bearing: without it a caller who owns ANY area could
 * revoke a token belonging to someone else's simply by naming it.
 */
export async function revokeCalendarToken(
  areaUuid: string,
  token: string,
): Promise<boolean> {
  const rows = await requirePlanetscaleDb()
    .update(areaCalendarTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(areaCalendarTokens.token, token),
        eq(areaCalendarTokens.areaId, areaUuid),
        isNull(areaCalendarTokens.revokedAt),
      ),
    )
    .returning({ token: areaCalendarTokens.token });
  return rows.length > 0;
}
