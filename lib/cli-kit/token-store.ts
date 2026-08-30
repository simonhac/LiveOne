/**
 * The CLI's local credential store — `~/.config/liveone/cli-auth.json`.
 *
 * A map KEYED BY ORIGIN, and that shape is a requirement, not a convenience: prod, preview and
 * localhost logins must coexist indefinitely, so `auth login` against one origin writes only that
 * origin's entry, and every command resolves its token strictly by the origin it is about to call.
 * There is deliberately NO cross-origin fallback — a missing entry is an auth failure with a login
 * hint, never a silent borrow of another environment's credential. (This also matches the Clerk
 * topology: dev and prod are separate instances, so a borrowed token could never work anyway —
 * except against preview, which shares prod's Clerk instance, which is exactly the case where a
 * silent borrow would be dangerous rather than merely broken.)
 *
 * File hygiene: dir `0700`, file `0600`, written tmp-then-rename. A store readable by group/other
 * is REFUSED with a fix hint — a warning would just scroll past.
 *
 * Every function takes an explicit `filePath` (defaulting to the real location) so tests run
 * against a tmpdir and never touch the operator's credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, failWith } from "@/lib/cli/cli";

export const DEFAULT_STORE_PATH = path.join(
  os.homedir(),
  ".config",
  "liveone",
  "cli-auth.json",
);

export interface StoredToken {
  /** The `lo_cli_…` secret itself — this file is the ONLY place it exists in plaintext. */
  token: string;
  /** The server-side record id — what `auth revoke` names. */
  tokenId: string;
  userId: string;
  email: string | null;
  label: string;
  expiresAt: string;
}

export interface TokenStore {
  version: 1;
  /** The origin commands default to when `--base-url` is not given. Set by the first login. */
  defaultOrigin?: string;
  tokens: Record<string, StoredToken>;
}

const EMPTY: TokenStore = { version: 1, tokens: {} };

/** Canonicalize any URL-ish string to its origin, so keys never differ by a trailing slash. */
export function normalizeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw failWith(
      EXIT.USAGE,
      `"${url}"`,
      "that is not a URL",
      "pass a full origin, e.g. --base-url=https://www.liveone.energy",
    );
  }
}

export function readStore(filePath = DEFAULT_STORE_PATH): TokenStore {
  let raw: string;
  try {
    // Mode check BEFORE reading: a store readable by group/other is refused outright. The token
    // inside is a bearer credential; "warn and continue" is how a warning becomes wallpaper.
    const mode = fs.statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0)
      throw failWith(
        EXIT.AUTH,
        filePath,
        `the credential store is readable by others (mode ${mode.toString(8)})`,
        `run: chmod 600 ${filePath}`,
      );
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { ...EMPTY, tokens: {} };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as TokenStore;
    if (parsed?.version !== 1 || typeof parsed.tokens !== "object")
      throw new Error("wrong shape");
    return parsed;
  } catch {
    throw failWith(
      EXIT.AUTH,
      filePath,
      "the credential store is not readable as a v1 token store",
      "move it aside and run `liveone auth login` again",
    );
  }
}

export function writeStore(
  store: TokenStore,
  filePath = DEFAULT_STORE_PATH,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/** Record a login for ONE origin, leaving every other entry untouched. */
export function setToken(
  origin: string,
  entry: StoredToken,
  filePath = DEFAULT_STORE_PATH,
): TokenStore {
  const key = normalizeOrigin(origin);
  const store = readStore(filePath);
  const next: TokenStore = {
    ...store,
    // MOST RECENT LOGIN WINS. It was first-login-wins, and the result was that logging in to prod
    // after a localhost login left every subsequent command still pointed at localhost — the
    // target: line caught it, but only because someone read it. `auth login <origin>` is an
    // explicit statement of where you are working now, so it moves the default.
    defaultOrigin: key,
    tokens: { ...store.tokens, [key]: entry },
  };
  writeStore(next, filePath);
  return next;
}

/** Forget one origin's credential. Clears `defaultOrigin` too when it pointed here. */
export function removeToken(
  origin: string,
  filePath = DEFAULT_STORE_PATH,
): void {
  const key = normalizeOrigin(origin);
  const store = readStore(filePath);
  const { [key]: _dropped, ...rest } = store.tokens;
  const remaining = Object.keys(rest);
  writeStore(
    {
      ...store,
      // Logging out of the default origin adopts the ONLY remaining login, if there is exactly
      // one — otherwise there is no non-arbitrary answer, so it clears and the next command falls
      // back to prod (and says so on the target: line) rather than picking a host for you.
      defaultOrigin:
        store.defaultOrigin === key
          ? remaining.length === 1
            ? remaining[0]
            : undefined
          : store.defaultOrigin,
      tokens: rest,
    },
    filePath,
  );
}

/**
 * The credential for calls to `origin`, or null.
 *
 * `LIVEONE_CLI_TOKEN` (CI only) wins over the file — a pipeline injects one token for one target
 * and should not need a file on disk. There is NO other fallback: absent means "not logged in to
 * this origin", full stop.
 */
export function tokenFor(
  origin: string,
  filePath = DEFAULT_STORE_PATH,
): StoredToken | null {
  const env = process.env.LIVEONE_CLI_TOKEN;
  if (env)
    return {
      token: env,
      tokenId: "(env)",
      userId: "(env)",
      email: null,
      label: "LIVEONE_CLI_TOKEN",
      expiresAt: "",
    };
  return readStore(filePath).tokens[normalizeOrigin(origin)] ?? null;
}

/** Every stored login, for `auth list`-style displays. Never includes the secret. */
export function listEntries(
  filePath = DEFAULT_STORE_PATH,
): Array<{ origin: string; entry: Omit<StoredToken, "token"> }> {
  const store = readStore(filePath);
  return Object.entries(store.tokens).map(([origin, e]) => {
    const { token: _secret, ...entry } = e;
    return { origin, entry };
  });
}
