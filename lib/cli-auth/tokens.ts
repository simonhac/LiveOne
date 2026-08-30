/**
 * CLI tokens — the credential a LiveOne operator CLI presents to the deployed API as *them*.
 *
 * WHY THIS EXISTS. The alternative to a CLI credential is a Postgres connection string on the
 * operator's laptop. A `lo_cli_` token is strictly less dangerous: it acts as one Clerk user,
 * through the same route handlers and authorization checks the web app uses, and it is revocable
 * from the server without rotating a database role.
 *
 * SHAPE. `lo_cli_<base64url(userId)>.<32 random bytes, base64url>`.
 *
 * The separator is `.` — NOT `_` — because `.` is outside the base64url alphabet ([A-Za-z0-9-_]),
 * so the split is unambiguous by construction. `_` would in fact be safe today: exhaustively over
 * every 3-character triple of Clerk's id charset (alphanumerics plus `_`), base64url never emits
 * `_`. But that is a property of the CHARSET, not of the format — it would break silently if Clerk
 * ever widened its ids — and safety by construction costs nothing here. (JWT uses `.` for the same
 * reason.)
 *
 * The embedded userId is load-bearing rather than decorative: Clerk cannot query `privateMetadata`,
 * so the token has to say which user's record to fetch. It is not a secret (a Clerk user id is not
 * one) and it grants nothing on its own — only the random half is compared, and only against a
 * stored hash.
 *
 * STORED HASHED, in Clerk `privateMetadata` under `cliTokens`, mirroring the existing app-issued
 * credential precedent (`lib/secure-credentials.ts`, `scripts/fronius/mint-gusher-key.ts`). Clerk
 * metadata rather than a new table because it needs no migration, and because it is readable from
 * the edge if verification ever has to move there. `updateUserMetadata` merges shallowly at the top
 * level, so `cliTokens` coexists with the `version`/`credentials` keys that module owns.
 *
 * ACCOUNT-WIDE, NOT PER-TOOL: one credential serves every current and future CLI, and the phase-2
 * MCP server. `scopes` is reserved (default `["*"]`) so narrowing later is not a breaking re-mint.
 *
 * Everything here is PURE over an injected user record — no Clerk client, no clock of its own — so
 * the verification path is testable without a network or a fixture user.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TOKEN_PREFIX } from "./bearer";

export { TOKEN_PREFIX };

/** Where the records live inside `privateMetadata`. */
export const METADATA_KEY = "cliTokens";

/** Default lifetime, and the ceiling an operator may ask for. */
export const DEFAULT_TTL_DAYS = 90;
export const MAX_TTL_DAYS = 365;

/** How many live tokens one user may hold. Refusing the 11th beats an unbounded list. */
export const MAX_LIVE_TOKENS = 10;

export interface CliTokenRecord {
  /** Public identifier, safe to display and to revoke by. */
  id: string;
  /** sha256 of the secret half, hex. */
  hash: string;
  /** What machine/purpose this was minted for. */
  label: string;
  /** Reserved for future narrowing; `["*"]` today. */
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** The minimum of a Clerk user this module needs — so tests need no Clerk. */
export interface UserLike {
  id: string;
  privateMetadata?: Record<string, unknown> | null;
  publicMetadata?: Record<string, unknown> | null;
}

const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The records stored on a user, tolerating an absent or malformed key. */
export function recordsOf(user: UserLike): CliTokenRecord[] {
  const raw = (user.privateMetadata ?? {})[METADATA_KEY];
  return Array.isArray(raw) ? (raw as CliTokenRecord[]) : [];
}

export interface MintedToken {
  /** The full secret. Shown to the operator EXACTLY once; only its hash is stored. */
  token: string;
  record: CliTokenRecord;
  /** The records to persist — the caller writes these back to Clerk. */
  records: CliTokenRecord[];
}

/**
 * Mint a token for `user`, returning the secret and the records to store.
 *
 * `now` is injected rather than read, so expiry logic is testable without waiting or mocking a
 * global clock.
 */
export function mintToken(
  user: UserLike,
  opts: { label: string; ttlDays?: number; now: Date },
): MintedToken {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_TTL_DAYS)
    throw new Error(`ttlDays must be an integer 1..${MAX_TTL_DAYS}`);

  // Prune expired/revoked before counting, so a user who has simply let tokens lapse is not
  // blocked by them.
  const kept = recordsOf(user).filter((r) => isLive(r, opts.now));
  if (kept.length >= MAX_LIVE_TOKENS)
    throw new Error(
      `${user.id} already holds ${kept.length} live CLI tokens (max ${MAX_LIVE_TOKENS}) — revoke one first`,
    );

  const secret = b64url(randomBytes(32));
  const token = `${TOKEN_PREFIX}${b64url(Buffer.from(user.id, "utf8"))}.${secret}`;
  const expires = new Date(opts.now.getTime() + ttlDays * 86_400_000);
  const record: CliTokenRecord = {
    id: `cli_${b64url(randomBytes(6))}`,
    hash: sha256(secret),
    label: opts.label,
    scopes: ["*"],
    createdAt: opts.now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  return { token, record, records: [...kept, record] };
}

/**
 * Live = not revoked, and expiring strictly in the future.
 *
 * The `> now` orientation is deliberate: an unparseable `expiresAt` yields NaN, and every
 * comparison with NaN is false, so a malformed record reads as DEAD here. Written the other way
 * round (`<= now` for "expired") the same record would read as alive — fail-open on exactly the
 * field that bounds a credential's life.
 */
export function isLive(r: CliTokenRecord, now: Date): boolean {
  return !r.revokedAt && new Date(r.expiresAt).getTime() > now.getTime();
}

export interface ParsedToken {
  userId: string;
  secret: string;
}

/**
 * Split a presented token into the user it claims and the secret it offers. Never throws — a
 * malformed token is simply not a token.
 */
export function parseToken(raw: string): ParsedToken | null {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const body = raw.slice(TOKEN_PREFIX.length);
  // `.` cannot occur in either half (both are base64url), so exactly one separator is expected.
  const sep = body.indexOf(".");
  if (sep <= 0 || body.indexOf(".", sep + 1) !== -1) return null;
  const encodedUser = body.slice(0, sep);
  const secret = body.slice(sep + 1);
  if (!secret) return null;
  let userId: string;
  try {
    userId = Buffer.from(encodedUser, "base64url").toString("utf8");
  } catch {
    return null;
  }
  // A decoded id must look like one; base64url will happily decode arbitrary bytes.
  if (!/^[A-Za-z0-9_-]{4,}$/.test(userId)) return null;
  return { userId, secret };
}

export type VerifyFailure =
  | "malformed"
  | "wrong-user"
  | "unknown-secret"
  | "expired"
  | "revoked";

export type VerifyResult =
  | { ok: true; record: CliTokenRecord }
  | { ok: false; reason: VerifyFailure };

/**
 * Does `raw` authenticate as `user`?
 *
 * Constant-time comparison on the hash: a token secret is a 256-bit random value, so sha256 (not a
 * password KDF) is the right primitive, but the comparison should still not leak position.
 *
 * The distinction between `unknown-secret`, `expired` and `revoked` is for the SERVER's logs and
 * tests. It must never be reported to the caller, who gets one undifferentiated 401 — otherwise
 * the response tells an attacker which half of the guess was right.
 */
export function verifyToken(
  raw: string,
  user: UserLike,
  now: Date,
): VerifyResult {
  const parsed = parseToken(raw);
  if (!parsed) return { ok: false, reason: "malformed" };
  // The token names a user; the caller fetched one. If they disagree the token is being replayed
  // against the wrong record.
  if (parsed.userId !== user.id) return { ok: false, reason: "wrong-user" };

  const want = Buffer.from(sha256(parsed.secret), "hex");
  const match = recordsOf(user).find((r) => {
    let got: Buffer;
    try {
      got = Buffer.from(r.hash, "hex");
    } catch {
      return false;
    }
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!match) return { ok: false, reason: "unknown-secret" };
  if (match.revokedAt) return { ok: false, reason: "revoked" };
  // Liveness is `isLive` and nothing else. Comparing `new Date(expiresAt).getTime() <= now` here
  // instead would disagree with it on a malformed date: NaN makes that comparison FALSE, so a
  // record with a missing or unparseable `expiresAt` would verify forever while `isLive` (and so
  // the mint-time pruning and the `auth list` display) treated it as dead. Two functions
  // disagreeing about whether a credential is valid is how a fail-open gets built.
  if (!isLive(match, now)) return { ok: false, reason: "expired" };
  return { ok: true, record: match };
}

/** Mark one token revoked, or all of them. Returns the records to persist. */
export function revokeToken(
  user: UserLike,
  opts: { id?: string; all?: boolean; now: Date },
): { records: CliTokenRecord[]; revoked: number } {
  let revoked = 0;
  const records = recordsOf(user).map((r) => {
    const hit = opts.all || r.id === opts.id;
    if (!hit || r.revokedAt) return r;
    revoked++;
    return { ...r, revokedAt: opts.now.toISOString() };
  });
  return { records, revoked };
}

/**
 * The shape safe to show an operator: never the hash, never the secret.
 */
export function describeTokens(
  user: UserLike,
  now: Date,
): Array<Omit<CliTokenRecord, "hash"> & { live: boolean }> {
  return recordsOf(user).map(({ hash: _hash, ...rest }) => ({
    ...rest,
    live: isLive(rest as CliTokenRecord, now),
  }));
}

/**
 * Should `lastUsedAt` be written on this request?
 *
 * Throttled to once an hour: every CLI request would otherwise cost a Clerk write, on the request
 * path, to record something nobody reads at that resolution.
 */
export function shouldTouch(r: CliTokenRecord, now: Date): boolean {
  if (!r.lastUsedAt) return true;
  return now.getTime() - new Date(r.lastUsedAt).getTime() > 3_600_000;
}
