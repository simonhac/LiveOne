/**
 * `liveone dashboard share` and `liveone dashboard link` — declaration only, no I/O.
 */
import { type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../../shared";

const DASH_ARG = {
  name: "dash",
  required: true,
  help: "A dashboard: its db_… id or its slug",
} as const;

export const SHARE_SPEC = {
  name: "share",
  summary: "Named users granted on a dashboard (writes: add, remove, set).",
  when:
    "A grant is how a NAMED user sees a dashboard — and, through it, the devices the doc\n" +
    "references. For an anonymous link use `dashboard link`.",
  description:
    "🛑 A grant is read-scoped LIVE to the doc's refs, not to a snapshot: editing the document\n" +
    "re-aims every grant on it. Granting someone is therefore not a promise about which devices\n" +
    "they will see tomorrow.",
  subcommands: {
    list: {
      name: "list",
      summary: "The dashboard's members, and each one's grant role.",
      args: [DASH_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone dashboard share list kew"],
    },
    add: {
      name: "add",
      summary: "Grant users on a dashboard, keeping existing members.",
      when:
        "The incremental verb. The route is a full replace, so this reads the membership first —\n" +
        "sending one member alone would evict everyone else.",
      mutates: true,
      args: [
        DASH_ARG,
        {
          name: "user",
          required: true,
          variadic: true,
          help: "Users: user_… id, email, or username",
        },
      ],
      flags: {
        ...BASE_URL_FLAG,
        role: {
          type: "string",
          placeholder: "viewer",
          values: ["viewer", "admin"],
          help: "Grant role (default: viewer)",
        },
      },
      exitCodes: {
        1: "the server refused the membership (the reason says why)",
      },
      examples: [
        "liveone dashboard share add kew karoline@example.com",
        "liveone dashboard share add kew karoline@example.com --role=admin --apply",
      ],
    },
    remove: {
      name: "remove",
      summary: "Revoke users from a dashboard, keeping the rest.",
      mutates: true,
      args: [
        DASH_ARG,
        {
          name: "user",
          required: true,
          variadic: true,
          help: "Users to revoke",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: {
        1: "the server refused the membership (the reason says why)",
      },
      examples: [
        "liveone dashboard share remove kew someone@example.com --apply",
      ],
    },
    set: {
      name: "set",
      summary: "Declare the exact membership — anyone omitted is revoked.",
      when:
        "The full-replace form, matching the route. Prefer `add`/`remove` unless you mean 'these\n" +
        "and only these'.",
      mutates: true,
      args: [
        DASH_ARG,
        {
          name: "user",
          required: false,
          variadic: true,
          help: "The complete membership (none = revoke everyone)",
        },
      ],
      flags: {
        ...BASE_URL_FLAG,
        role: {
          type: "string",
          placeholder: "viewer",
          values: ["viewer", "admin"],
          help: "Grant role for everyone named (default: viewer)",
        },
      },
      exitCodes: {
        1: "the server refused the membership (the reason says why)",
      },
      examples: ["liveone dashboard share set kew simon@example.com --apply"],
    },
  },
} satisfies CommandSpec;

export const LINK_SPEC = {
  name: "link",
  summary: "Anonymous share links for a dashboard (writes: create, revoke).",
  when:
    "A link lets someone with the URL read the dashboard WITHOUT signing in. For a named user\n" +
    "use `dashboard share`.",
  description:
    "🛑 A link's scope is derived live from the doc's refs, exactly like a grant — so editing the\n" +
    "document re-aims every live link. Revocation is the only way to narrow one.",
  subcommands: {
    list: {
      name: "list",
      summary:
        "The dashboard's links: label, created, expiry, last use, revoked.",
      args: [DASH_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone dashboard link list kew"],
    },
    create: {
      name: "create",
      summary: "Mint a new share link.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...BASE_URL_FLAG,
        label: {
          type: "string",
          placeholder: "text",
          help: "What this link is for — the only way to tell two links apart later",
        },
        expiresInDays: {
          type: "number",
          placeholder: "30",
          help: "Expire after N days (default: never)",
        },
      },
      exitCodes: { 1: "the server refused (the reason says why)" },
      examples: [
        "liveone dashboard link create kew --label='for the installer' --expires-in-days=30 --apply",
      ],
    },
    revoke: {
      name: "revoke",
      summary: "Revoke a share link. Idempotent.",
      mutates: true,
      args: [
        DASH_ARG,
        { name: "token", required: true, help: "The token to revoke" },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: { 1: "the server refused (the reason says why)" },
      examples: ["liveone dashboard link revoke kew abc123 --apply"],
    },
  },
} satisfies CommandSpec;

/**
 * Deletion lives beside the sharing verbs on purpose: what makes deleting a dashboard consequential
 * is not the document, it is everything the FK cascade takes with it — every grant, and every live
 * share token. Those are this module's subject.
 */
export const DELETE_SPEC = {
  name: "delete",
  summary: "Delete a dashboard — and every grant and share link on it.",
  when:
    "🛑 IRREVERSIBLE, and wider than it looks. `dashboard_grants`, `share_tokens` and the whole\n" +
    "revision history all cascade from `dashboards.id`, so deleting a document silently revokes\n" +
    "every live link on it. The dry run names them before you commit to that.",
  description:
    "A share token's SCOPE comes from the doc's refs, so a card-less dashboard can still be\n" +
    "conveying read access to whole areas — which is exactly the kind that looks safe to delete\n" +
    "and is the most important to look at first.",
  mutates: true,
  args: [DASH_ARG],
  flags: { ...BASE_URL_FLAG },
  exitCodes: { 1: "the server refused (the reason says why)" },
  examples: [
    "liveone dashboard delete legacy-share-keen-fruity-tapir",
    "liveone dashboard delete legacy-share-keen-fruity-tapir --apply",
  ],
} satisfies CommandSpec;
