/**
 * The `auth` domain of the `liveone` CLI — sign the CLI in as YOU, so the other domains can talk
 * to the deployed API instead of needing a Postgres credential on this machine.
 *
 * A COMPOSABLE module, not an entrypoint (see the note in scripts/ops/dashboard/cli.ts — a module
 * with `run()` cannot be mounted, and importing it would execute it). `scripts/ops/liveone.ts`
 * mounts it.
 *
 * The credential (`lo_cli_…`) lives in `~/.config/liveone/cli-auth.json`, KEYED BY ORIGIN — prod,
 * preview and localhost logins coexist, and a command only ever uses the token for the origin it is
 * calling. See lib/cli-kit/token-store.ts for why there is no cross-origin fallback.
 */
import os from "node:os";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  defineCommand,
  failWith,
  EXIT,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import {
  awaitCallback,
  challengeFor,
  loginUrl,
  newState,
  newVerifier,
  stateMatches,
} from "@/lib/cli-kit/handoff";
import {
  listEntries,
  removeToken,
  setToken,
  tokenFor,
  type StoredToken,
} from "@/lib/cli-kit/token-store";
import { apiFetch } from "@/lib/cli-kit/http";
import { requireToken, resolveOrigin } from "@/lib/cli-kit/target";
import { bool, num, str } from "@/lib/cli/cli";

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

/** Paste-mode prompt. TTY only — off a terminal a prompt is a hang, so refuse instead. */
async function promptForCode(): Promise<string> {
  if (!process.stdin.isTTY)
    throw failWith(
      EXIT.USAGE,
      "--no-browser without a terminal",
      "the paste flow needs an interactive terminal to read the code",
      "run it at a terminal, or use the browser flow",
    );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) =>
    rl.question("Paste the code shown in the browser: ", resolve),
  );
  rl.close();
  return answer.trim();
}

async function runLogin(ctx: Ctx): Promise<number> {
  const origin = resolveOrigin(ctx, { useStoredDefault: false });
  const label = str(ctx, "label") ?? os.hostname();
  const verifier = newVerifier();
  const challenge = challengeFor(verifier);
  const state = newState();

  let code: string;
  const useBrowser = !bool(ctx, "noBrowser") && process.platform === "darwin";
  if (useBrowser) {
    const listener = await awaitCallback();
    const url = loginUrl(origin, {
      challenge,
      state,
      port: listener.port,
      label,
    });
    ctx.note(
      `Opening the browser to approve this sign-in. If it does not open, visit:\n  ${url}`,
    );
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    const cb = await listener.result;
    // The constant-time state check is the loopback CSRF defence: a hostile local page that
    // guessed the ephemeral port still cannot produce the state this process generated.
    if (!stateMatches(state, cb.state))
      throw failWith(
        EXIT.AUTH,
        "state mismatch on the login callback",
        "the callback did not come from the approval this run initiated",
        "re-run `liveone auth login`",
      );
    code = cb.code;
  } else {
    const url = loginUrl(origin, { challenge, state, label });
    ctx.note(`Open this URL in a browser where you are signed in:\n  ${url}`);
    code = await promptForCode();
  }
  if (!code)
    throw failWith(
      EXIT.AUTH,
      "no code received",
      "the approval did not produce a code",
      "re-run `liveone auth login`",
    );

  const ttl = num(ctx, "ttl");
  void ttl; // TTL is minted server-side today (90d); the flag is accepted for forward-compat and validated, but not yet sent.

  // The three statuses `exchange` gives its own meaning; everything else — the redirect refusal,
  // the protect-rewrite 404 — is apiFetch's shared vocabulary, which is the point of using it.
  const { body: token } = await apiFetch<{
    token: string;
    tokenId: string;
    label: string;
    expiresAt: string;
  }>(origin, "/api/cli-auth/exchange", {
    method: "POST",
    body: { code, verifier },
    errors: {
      400: {
        exit: EXIT.AUTH,
        what: "the exchange was refused",
        why: (b) => String(b.error ?? "the code was not accepted"),
        next: "the code may have expired (5 minutes) — re-run `liveone auth login`",
      },
      409: {
        exit: EXIT.FINDINGS,
        what: "token cap reached",
        why: (b) => String(b.error ?? "too many live CLI tokens"),
        next: "run `liveone auth revoke --all` (or revoke one) and log in again",
      },
      503: {
        exit: EXIT.UPSTREAM,
        what: `${origin} has CLI auth disabled`,
        why: (b) =>
          String(b.error ?? "CLI auth is not configured on this deployment"),
        next: "set CLI_AUTH_SIGNING_SECRET on that deployment and redeploy",
      },
    },
  });

  // Enrich with whoami so the operator sees WHO and WHERE they now are — the same facts the
  // target: line will print on every later command.
  const { body: who } = await apiFetch(origin, "/api/cli-auth/whoami", {
    token: token.token,
  });

  setToken(origin, {
    token: token.token,
    tokenId: token.tokenId,
    userId: String(who.userId ?? ""),
    email: (who.email as string | null) ?? null,
    label: token.label,
    expiresAt: token.expiresAt,
  });

  ctx.emit(
    {
      origin,
      tokenId: token.tokenId,
      label: token.label,
      expiresAt: token.expiresAt,
      user: { userId: who.userId, email: who.email, isAdmin: who.isAdmin },
      env: {
        vercelEnv: who.vercelEnv,
        clerkInstance: who.clerkInstance,
        dbHost: who.dbHost,
      },
    },
    (m: never) => {
      const model = m as {
        origin: string;
        tokenId: string;
        expiresAt: string;
        user: { email?: string; userId?: string; isAdmin?: boolean };
        env: { clerkInstance?: string; dbHost?: string };
      };
      return [
        `Signed in to ${model.origin} as ${model.user.email ?? model.user.userId}${model.user.isAdmin ? " (admin)" : ""}.`,
        `  clerk ${model.env.clerkInstance} · db ${model.env.dbHost}`,
        `  token ${model.tokenId}, expires ${model.expiresAt}`,
        // Say it out loud: this login just re-pointed every later command.
        `Commands now default to ${model.origin} — override per call with --base-url.`,
        `Revoke it any time with \`liveone auth revoke ${model.tokenId}\`.`,
      ].join("\n");
    },
  );
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// the other verbs
// ---------------------------------------------------------------------------

async function runWhoami(ctx: Ctx): Promise<number> {
  const origin = resolveOrigin(ctx);
  const entry = requireToken(origin);
  const { body: who } = await apiFetch(origin, "/api/cli-auth/whoami", {
    token: entry.token,
  });
  ctx.emit({ origin, ...who }, (m: never) => {
    const w = m as Record<string, unknown>;
    return `target: ${w.origin} as ${w.email ?? w.userId}${w.isAdmin ? " (admin)" : ""} · clerk ${w.clerkInstance} · db ${w.dbHost} · build ${w.buildSha ?? "?"}`;
  });
  return EXIT.OK;
}

async function runList(ctx: Ctx): Promise<number> {
  const origin = resolveOrigin(ctx);
  const entry = requireToken(origin);
  const all = bool(ctx, "all");
  const { body } = await apiFetch(
    origin,
    `/api/cli-auth/tokens${all ? "?all=true" : ""}`,
    { token: entry.token },
  );
  const locals = listEntries();
  ctx.emit(
    { origin, tokens: body.tokens, localOrigins: locals.map((l) => l.origin) },
    (m: never) => {
      const model = m as {
        origin: string;
        tokens: Array<{
          id: string;
          label: string;
          expiresAt: string;
          lastUsedAt?: string;
          live: boolean;
        }>;
        localOrigins: string[];
      };
      const rows = model.tokens.map(
        (t) =>
          `  ${t.id.padEnd(14)} ${t.label.padEnd(20)} expires ${t.expiresAt}` +
          `${t.lastUsedAt ? `  last used ${t.lastUsedAt}` : ""}${t.live ? "" : "  (dead)"}`,
      );
      return [
        `${model.tokens.length} token(s) on ${model.origin}:`,
        ...rows,
        `This machine holds logins for: ${model.localOrigins.join(", ") || "(none)"}`,
      ].join("\n");
    },
  );
  return EXIT.OK;
}

async function runRevoke(ctx: Ctx): Promise<number> {
  const origin = resolveOrigin(ctx);
  const entry = requireToken(origin);
  const id = ctx.args[0];
  const all = bool(ctx, "all");
  if (!id === !all)
    throw failWith(
      EXIT.USAGE,
      all && id ? "both a tokenId and --all" : "neither a tokenId nor --all",
      "revoke takes exactly one target",
      "pass a token id from `liveone auth list`, or --all",
    );
  const { body } = await apiFetch(
    origin,
    `/api/cli-auth/tokens/${encodeURIComponent(id ?? "all")}${all ? "?all=true" : ""}`,
    { method: "DELETE", token: entry.token },
  );
  // Revoking the CURRENT token (directly or via --all) leaves a dead entry in the local store.
  if (all || id === entry.tokenId) removeToken(origin);
  ctx.emit({ origin, revoked: body.revoked ?? 0 }, (m: never) => {
    const model = m as { revoked: number };
    return `${model.revoked} token(s) revoked.`;
  });
  return EXIT.OK;
}

async function runLogout(ctx: Ctx): Promise<number> {
  const origin = resolveOrigin(ctx);
  const entry = tokenFor(origin);
  if (!entry) {
    ctx.emit(
      { origin, revoked: 0, forgot: false },
      () => `Not logged in to ${origin}.`,
    );
    return EXIT.OK;
  }
  let revoked = 0;
  try {
    const { body } = await apiFetch(
      origin,
      `/api/cli-auth/tokens/${encodeURIComponent(entry.tokenId)}`,
      { method: "DELETE", token: entry.token },
    );
    revoked = Number(body.revoked ?? 0);
  } catch (err) {
    // Best-effort: an unreachable server must not stop the local credential being forgotten.
    ctx.warn(
      `could not revoke server-side (${err instanceof Error ? err.message : err}) — forgetting the local copy anyway`,
    );
  }
  removeToken(origin);
  ctx.emit({ origin, revoked, forgot: true }, (m: never) => {
    const model = m as { origin: string; revoked: number };
    return `Logged out of ${model.origin}${model.revoked ? " (token revoked server-side)" : " (local copy forgotten; server-side revoke did not confirm)"}.`;
  });
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// the domain
// ---------------------------------------------------------------------------

const BASE_URL_FLAG = {
  type: "string",
  placeholder: "origin",
  help: "Target origin (default: your stored default, else https://www.liveone.energy)",
} as const;

export const authCommand = defineCommand({
  name: "auth",
  summary: "Sign the CLI in as you, and manage its tokens.",
  when:
    "Run `auth login` once per machine per environment before using any domain over the API.\n" +
    "Everything here manages the lo_cli_ credential; the dashboard domain USES it.",
  description:
    "Tokens are stored per-origin in ~/.config/liveone/cli-auth.json (mode 600) — prod, preview\n" +
    "and localhost logins coexist, and a command only ever uses the token for the origin it calls.\n" +
    "The login itself happens in your browser, where you are already signed in; the CLI never sees\n" +
    "your password, and the code shown there is useless without the verifier this process keeps.",
  uses: ["api"],
  subcommands: {
    login: {
      name: "login",
      summary: "Sign in via the browser and store a token for one origin.",
      when:
        "The first command to run on a new machine, and the fix for any exit-3 'not logged in'.\n" +
        "Use --base-url to log in to dev/preview alongside prod.",
      flags: {
        baseUrl: BASE_URL_FLAG,
        label: {
          type: "string",
          placeholder: "text",
          help: "How this machine appears in `auth list` (default: hostname)",
        },
        ttl: {
          type: "number",
          placeholder: "days",
          schema: z.number().int().min(1).max(365),
          hint: "1–365 days",
          help: "Requested token lifetime (server currently mints 90d; accepted for forward-compat)",
        },
        noBrowser: {
          type: "boolean",
          help: "Print the URL and paste the code by hand (SSH / non-mac)",
        },
      },
      examples: [
        "liveone auth login",
        "liveone auth login --base-url=http://localhost:3001 --label=dev-laptop",
        "liveone auth login --no-browser",
      ],
    },
    whoami: {
      name: "whoami",
      summary:
        "Who and where the stored token makes you — the target line, on demand.",
      when:
        "Run this when unsure which deployment or database a command would hit; it names the\n" +
        "origin, the user, the Clerk instance and the DB host in one line.",
      flags: { baseUrl: BASE_URL_FLAG },
      examples: [
        "liveone auth whoami",
        "liveone auth whoami --base-url=http://localhost:3001",
      ],
    },
    list: {
      name: "list",
      summary:
        "The live tokens on your account (server-side), plus this machine's logins.",
      when: "Answers 'what can currently access my account'. --all includes dead records.",
      flags: {
        baseUrl: BASE_URL_FLAG,
        all: {
          type: "boolean",
          help: "Include revoked/expired records not yet swept",
        },
      },
      examples: ["liveone auth list", "liveone auth list --all"],
    },
    revoke: {
      name: "revoke",
      summary: "Revoke one token by id, or all of them.",
      when:
        "Lost a machine, or `list` shows something unexpected. Revocation takes effect on the\n" +
        "next request. Revoking the token you are using also forgets it locally.",
      args: [
        {
          name: "tokenId",
          help: "A token id from `auth list` (omit when using --all)",
        },
      ],
      flags: {
        baseUrl: BASE_URL_FLAG,
        all: {
          type: "boolean",
          help: "Revoke every live token on the account",
        },
      },
      examples: [
        "liveone auth revoke cli_Rf-c6ac5",
        "liveone auth revoke --all",
      ],
    },
    logout: {
      name: "logout",
      summary: "Revoke this origin's token server-side and forget it locally.",
      when: "Leaving a machine or handing it over. Best-effort server revoke, then local removal.",
      flags: { baseUrl: BASE_URL_FLAG },
      examples: ["liveone auth logout"],
    },
  },
} satisfies CommandSpec);

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  login: runLogin,
  whoami: runWhoami,
  list: runList,
  revoke: runRevoke,
  logout: runLogout,
};

/** Dispatch on the verb — the LAST element of the path, since the path is ["auth", "<verb>"]. */
export async function runAuth(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw failWith(
      EXIT.USAGE,
      `unknown auth command "${verb}"`,
      "this verb has no handler",
      "run `liveone auth --help`",
    );
  return handler(ctx);
}
