/**
 * The `user` domain of the `liveone` CLI — the user directory: who exists, what they own.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * ADMIN-ONLY over http: the `/api/v4/users` routes are `requireAdmin`, so a non-admin token gets
 * the mapped 403. Identity lives in Clerk; the directory joins it with device ownership.
 */
import {
  defineCommand,
  EXIT,
  failWith,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { BASE_URL_FLAG, usage } from "../shared";

interface WireUser {
  clerkUserId: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  createdAt: number | string;
  lastSignIn?: number | null;
  devices: Array<{
    systemId: number;
    vendorType: string;
    vendorSiteId: string | null;
    displayName: string;
    status: string;
  }>;
  isPlatformAdmin?: boolean;
}

const USER_ARG = {
  name: "user",
  required: true,
  help: "A user: their user_… Clerk id, email, or username",
} as const;

/**
 * `user_…` goes straight through; anything else matches email/username over the directory, and then
 * over CLERK.
 *
 * 🛑 The Clerk fall-through is not a convenience. The directory is derived from DEVICE OWNERSHIP, so
 * a user who owns nothing is not in it — which is exactly the person you are about to transfer
 * something TO. Resolving only against the list would make `--to=someone@new` unresolvable for
 * precisely the case ownership transfer exists for, and would send the operator to the Clerk
 * dashboard to copy an id by hand.
 */
export async function resolveUserId(
  s: ApiSession,
  ref: string,
): Promise<string> {
  if (ref.startsWith("user_")) return ref;
  const { users } = await s.get<{ users: WireUser[] }>("/api/v4/users");
  let hits = users.filter((u) => u.email === ref || u.username === ref);
  if (hits.length === 0) {
    // Exact only. A fuzzy `query` match is fine for `user find`, where a human reads the rows, and
    // wrong here, where the next step hands someone else's data to whoever came back first. If the
    // deployment cannot search, `searchUsers` throws and says so — better than resolving against a
    // list that was never filtered.
    const found = await searchUsers(s, ref);
    hits = found.filter((u) => u.email === ref || u.username === ref);
  }
  if (hits.length === 0)
    throw usage(
      `no user matches "${ref}"`,
      "no directory entry and no Clerk user has that id, email or username",
      "run `liveone user find <partial>` to search Clerk, or `liveone user list` for owners",
    );
  if (hits.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${hits.length} users:\n${hits.map((h) => `  ${h.clerkUserId}`).join("\n")}`,
      "address the user by their user_… id instead",
    );
  return hits[0].clerkUserId;
}

export const userCommand = defineCommand({
  name: "user",
  summary: "The user directory — who exists, what they own. Admin-only.",
  when:
    "Reach for this to see the platform's users and their device ownership. ADMIN-ONLY: a\n" +
    "non-admin CLI token is refused server-side.",
  description:
    "Read-only, and http-only: identity lives in Clerk, and the API joins it with device\n" +
    "ownership server-side. Prints `target: <origin> as <you>` on stderr first.",
  uses: ["api"],
  subcommands: {
    list: {
      name: "list",
      summary: "List users: Clerk id, email, devices owned.",
      when: "Start here when you do not know a user's id.",
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone user list"],
    },
    show: {
      name: "show",
      summary: "One user's directory entry, with their owned devices.",
      when: "Use this for one user's detail — devices, admin flag, default dashboard.",
      args: [USER_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: [
        "liveone user show simon@example.com",
        "liveone user show user_2yjTPLLmU2vMs4Vy4Q7g0Yy0abc",
      ],
    },
    find: {
      name: "find",
      summary: "Search CLERK for a user — including one who owns nothing.",
      when:
        "Use this when `list` does not show them. `list` is derived from device ownership, so a\n" +
        "newly invited user is invisible to it by definition — and that is the user a transfer is\n" +
        "usually about to hand something to.",
      description:
        "An exact email is matched as an email; anything else is a fuzzy search over name,\n" +
        "username and email. Exit 1 when nothing matches, so it composes into a check.",
      args: [
        {
          name: "search",
          required: true,
          help: "An email, or part of a name/username",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: { 1: "no user matched" },
      examples: [
        "liveone user find karoline@example.com",
        "liveone user find karoline",
      ],
    },
  },
} satisfies CommandSpec);

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const { users } = await s.get<{ users: WireUser[] }>("/api/v4/users");
    ctx.emit({ count: users.length, users }, () =>
      [
        ...users.map(
          (u) =>
            `${u.clerkUserId}  ${(u.email ?? "(no email)").padEnd(30)} ` +
            `devices=${String(u.devices.length).padEnd(3)}` +
            (u.isPlatformAdmin ? " admin" : ""),
        ),
        "",
        `${users.length} user(s).`,
      ].join("\n"),
    );
    return EXIT.OK;
  });
}

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const id = await resolveUserId(s, ctx.args[0]);
    const body = await s.get<Record<string, unknown>>(
      `/api/v4/users/${encodeURIComponent(id)}`,
    );
    // Object-heavy payload: the pretty JSON IS the human rendering.
    ctx.emit(body, () => JSON.stringify(body, null, 2));
    return EXIT.OK;
  });
}

/**
 * 🛑 An unknown query parameter is IGNORED by an older deployment, which answers the unfiltered
 * list with a 200. So a search against a deployment that predates `?q=` does not fail — it returns
 * every device-owning user and renders them as "matches", which is the most dangerous possible
 * answer to "does this person exist?". The route echoes `query` back for exactly this reason;
 * its absence means the search never ran.
 */
async function searchUsers(s: ApiSession, term: string): Promise<WireUser[]> {
  const body = await s.get<{ users: WireUser[]; query?: string }>(
    `/api/v4/users?q=${encodeURIComponent(term)}`,
  );
  if (body.query === undefined)
    throw failWith(
      EXIT.UPSTREAM,
      "this deployment cannot search Clerk",
      "it ignored `?q=` and returned the ownership-derived list instead — those rows are NOT matches",
      "check the deployed build with `liveone auth whoami`; `?q=` needs the release that added it",
    );
  return body.users;
}

async function runFind(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const term = ctx.args[0];
    const users = await searchUsers(s, term);
    ctx.emit({ query: term, count: users.length, users }, () =>
      users.length
        ? [
            ...users.map(
              (u) =>
                `${u.clerkUserId}  ${(u.email ?? "(no email)").padEnd(30)} ` +
                `${[u.firstName, u.lastName].filter(Boolean).join(" ").padEnd(24)} ` +
                `devices=${String(u.devices.length).padEnd(3)}` +
                (u.isPlatformAdmin ? " admin" : ""),
            ),
            "",
            `${users.length} match(es) in Clerk.`,
          ].join("\n")
        : `No Clerk user matches "${term}".`,
    );
    // A search that found nobody is a FINDING, not an error — it composes into a check, and it is
    // the honest answer to "does this person exist yet?".
    return users.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
  find: runFind,
};

/** Run whichever `user` verb was selected (the LAST path element under `liveone`). */
export async function runUser(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown user command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- user --help`",
    );
  return handler(ctx);
}
