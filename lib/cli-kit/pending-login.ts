/**
 * The half-finished login — `~/.config/liveone/cli-auth-pending.json`.
 *
 * The browser hand-off is one continuous process everywhere it can be: `auth login` holds the
 * verifier in memory, opens the browser, and exchanges the code without it ever touching disk. Two
 * environments cannot do that. The loopback leg is mac-only, and the paste leg needs a TTY to read
 * the code back — so on a headless box (CI, a container, an agent session, SSH without a terminal)
 * there was no flow at all, and the only way through was to reimplement PKCE by hand against
 * /api/cli-auth/exchange.
 *
 * So `--manual` splits the flow across two invocations, and the verifier has to survive between
 * them. That is the ONLY reason this file exists, and it is why the record is written with the
 * token store's hygiene (dir 0700, file 0600, tmp-then-rename, group/other-readable REFUSED) rather
 * than something looser: it is a credential-shaped secret sitting on disk, even if a short-lived one.
 *
 * 🛑 The verifier must never travel any other way. Printing it, passing it as a flag, or putting it
 * in an env var would undo PKCE entirely — the point of the scheme is that the code shown in the
 * browser is useless to anyone who observes it, and that only holds while its verifier stays where
 * the browser cannot reach and the scrollback cannot keep it.
 *
 * The record is consumed on success and never reused: a second `--code` with the same pending
 * record would be exchanging against a challenge the server has already satisfied.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, failWith } from "@/lib/cli/cli";

/** Not exported: unlike the token store's path, nothing outside this module addresses the record. */
const DEFAULT_PENDING_PATH = path.join(
  os.homedir(),
  ".config",
  "liveone",
  "cli-auth-pending.json",
);

/**
 * How long a `--manual` record stays exchangeable.
 *
 * Deliberately much longer than the code's own 5-minute TTL, because the two clocks measure
 * different things: the code expires 5 minutes after the human APPROVES, while this expires an hour
 * after the URL was PRINTED, and the gap between those two events is however long it takes someone
 * to find their phone. The expiry is here for staleness, not security — without it, a `--manual`
 * run abandoned last week would answer a fresh `--code` with a challenge-mismatch 400, which reads
 * as "the server rejected your code" when the real fault is a stale file.
 */
export const PENDING_TTL_MS = 60 * 60_000;

export interface PendingLogin {
  version: 1;
  /** The origin this hand-off was started against; `--code` must agree with it. */
  origin: string;
  /** 🛑 The PKCE verifier. The whole reason this file is 0600. */
  verifier: string;
  /** Echoed in the URL for parity with the interactive paste flow; unused on this leg. */
  state: string;
  label: string;
  /** Epoch ms, for the staleness check above. */
  createdAt: number;
}

function assertPrivate(filePath: string): void {
  // Mode check BEFORE reading, exactly as the token store does it: a verifier readable by others is
  // a broken PKCE binding, and "warn and continue" is how a warning becomes wallpaper.
  const mode = fs.statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw failWith(
      EXIT.AUTH,
      filePath,
      `the pending-login record is readable by others (mode ${mode.toString(8)})`,
      `run: chmod 600 ${filePath}`,
    );
}

/** Persist the in-flight hand-off. Overwrites any earlier one — the newest URL is the live one. */
export function writePending(
  pending: PendingLogin,
  filePath = DEFAULT_PENDING_PATH,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pending, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
}

/** The in-flight hand-off, or null when there is none. Throws on one that is unusable. */
export function readPending(
  filePath = DEFAULT_PENDING_PATH,
  nowMs = Date.now(),
): PendingLogin | null {
  let raw: string;
  try {
    assertPrivate(filePath);
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: PendingLogin;
  try {
    parsed = JSON.parse(raw) as PendingLogin;
    if (parsed?.version !== 1 || typeof parsed.verifier !== "string")
      throw new Error("wrong shape");
  } catch {
    throw failWith(
      EXIT.AUTH,
      filePath,
      "the pending-login record is not readable as a v1 record",
      "run `liveone auth login --manual` again",
    );
  }

  if (nowMs - parsed.createdAt > PENDING_TTL_MS) {
    // Cleared rather than merely reported: leaving it would make the NEXT `--code` fail the same
    // way, and a stale secret on disk has no reason to outlive the flow it belonged to.
    clearPending(filePath);
    throw failWith(
      EXIT.AUTH,
      "the pending login has expired",
      `it was started more than ${Math.round(PENDING_TTL_MS / 60_000)} minutes ago`,
      "run `liveone auth login --manual` again for a fresh URL",
    );
  }
  return parsed;
}

/** Consume the record. Idempotent — a missing file is the desired end state, not an error. */
export function clearPending(filePath = DEFAULT_PENDING_PATH): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
