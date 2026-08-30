/**
 * The `user` domain of the `liveone` CLI — the user directory: who exists, what they own.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * ADMIN-ONLY over http: the `/api/v4/users` routes are `requireAdmin`, so a non-admin token gets
 * the mapped 403. Identity lives in Clerk; the directory joins it with device ownership.
 */
import { defineCommand, EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
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

/** user_… goes straight to the show route; anything else matches email/username over the list. */
async function resolveUserId(s: ApiSession, ref: string): Promise<string> {
  if (ref.startsWith("user_")) return ref;
  const { users } = await s.get<{ users: WireUser[] }>("/api/v4/users");
  const hits = users.filter((u) => u.email === ref || u.username === ref);
  if (hits.length === 0)
    throw usage(
      `no user matches "${ref}"`,
      "no directory entry has that id, email or username",
      "run `liveone user list`",
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

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  list: runList,
  show: runShow,
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
