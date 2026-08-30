/**
 * The authorization code exchanged during the browser hand-off, and the PKCE binding that makes it
 * safe to hand through a browser.
 *
 * THE FLOW. `dashboard auth login` generates a random `verifier`, sends only its sha256
 * (`challenge`) to the app, and opens the browser. The user — already signed in — approves on a
 * Clerk-gated page, which mints a CODE. The CLI then exchanges `code + verifier` for a token.
 *
 * WHY STATELESS. The code is a signed, self-contained blob rather than a row in a pending-requests
 * table. That removes the entire store: no table (so no migration), no polling endpoint, no
 * cleanup job, and no way for the flow to half-fail with a stranded row. The cost is that a code
 * cannot be marked used, which is what the short expiry and the PKCE binding are for.
 *
 * WHY PKCE. The code travels through the browser — a redirect to 127.0.0.1, or a human copying it
 * over SSH — so it can plausibly be observed: shell history, a shoulder, a terminal scrollback. On
 * its own it is useless: the exchange also demands the `verifier`, which never leaves the CLI
 * process. Observing the code alone buys nothing.
 *
 * REPLAY, HONESTLY. Nothing marks a code spent, so a caller holding BOTH code and verifier inside
 * the 5-minute window can exchange twice and get two tokens. Both belong to the same user and both
 * are individually revocable, and the verifier never leaves the process that made it — so the
 * exposure is a process that already had the credential minting a second one. Accepted
 * deliberately; a `cli_tokens` table is what strict single-use would cost, and that is the point at
 * which it would earn its keep.
 *
 * Pure: no clock of its own, no I/O. `now` and `secret` are injected.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** How long a minted code is exchangeable for. Long enough to approve, short enough to matter. */
export const CODE_TTL_SECONDS = 300;

/** Clock-skew tolerance between the minting and exchanging sides. */
export const CODE_SKEW_SECONDS = 60;

export interface CodePayload {
  /** The Clerk user who approved. */
  u: string;
  /** sha256(verifier), base64url — the PKCE challenge. */
  c: string;
  /** The label the CLI asked for, so the minted token records which machine it is for. */
  l: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

const b64u = (s: string | Buffer) =>
  Buffer.from(s as never).toString("base64url");

/** sha256 of a verifier, base64url — what the CLI sends and the exchange re-derives. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a code for an approved hand-off. */
export function mintCode(
  payload: Omit<CodePayload, "exp">,
  opts: { secret: string; now: Date; ttlSeconds?: number },
): string {
  if (!opts.secret) throw new Error("CLI_AUTH_SIGNING_SECRET is not set");
  const exp =
    Math.floor(opts.now.getTime() / 1000) +
    (opts.ttlSeconds ?? CODE_TTL_SECONDS);
  const body = b64u(JSON.stringify({ ...payload, exp }));
  return `${body}.${sign(body, opts.secret)}`;
}

export type CodeFailure =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "challenge-mismatch";

export type CodeResult =
  | { ok: true; payload: CodePayload }
  | { ok: false; reason: CodeFailure };

/**
 * Verify a code AND the verifier that must accompany it.
 *
 * Order matters: signature first, then expiry, then the PKCE binding. A caller who fails the
 * signature check learns nothing about whether the code had expired.
 */
export function verifyCode(
  code: string,
  verifier: string,
  opts: { secret: string; now: Date },
): CodeResult {
  if (!opts.secret) throw new Error("CLI_AUTH_SIGNING_SECRET is not set");
  const dot = code.indexOf(".");
  if (dot <= 0 || code.indexOf(".", dot + 1) !== -1)
    return { ok: false, reason: "malformed" };
  const body = code.slice(0, dot);
  const mac = code.slice(dot + 1);

  const want = Buffer.from(sign(body, opts.secret), "utf8");
  const got = Buffer.from(mac, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want))
    return { ok: false, reason: "bad-signature" };

  let payload: CodePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.u !== "string" ||
    typeof payload?.c !== "string" ||
    typeof payload?.exp !== "number"
  )
    return { ok: false, reason: "malformed" };

  // Skew allowance is on the EXPIRY side only. A code cannot be used before it was minted anyway,
  // and being generous in both directions would just lengthen the window for no benefit.
  if (payload.exp + CODE_SKEW_SECONDS < Math.floor(opts.now.getTime() / 1000))
    return { ok: false, reason: "expired" };

  // The PKCE binding, in constant time. This is what makes an observed code worthless.
  const wantC = Buffer.from(payload.c, "utf8");
  const gotC = Buffer.from(challengeFor(verifier), "utf8");
  if (gotC.length !== wantC.length || !timingSafeEqual(gotC, wantC))
    return { ok: false, reason: "challenge-mismatch" };

  return { ok: true, payload };
}

/**
 * Is `state` the one the CLI generated? Compared in constant time.
 *
 * This is the CSRF / mix-up defence for the loopback leg: a hostile page that guesses the CLI's
 * ephemeral port still cannot produce the `state`, so the CLI ignores its callback.
 */
export function stateMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
