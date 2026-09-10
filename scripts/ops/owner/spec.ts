/**
 * The `owner` command tree — declaration only, no I/O.
 */
import { type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../shared";

export const OWNER_SUBCOMMANDS = {
  show: {
    name: "show",
    summary: "Who owns a device, an area or a dashboard.",
    when:
      "Ownership is what carries data access, so this is the first question before any transfer.\n" +
      "Give any ref — the verb works out which kind of thing it is.",
    args: [
      {
        name: "thing",
        required: true,
        help: "A device, area or dashboard: its TypeID, handle, slug or name",
      },
    ],
    flags: { ...BASE_URL_FLAG },
    exitCodes: { 1: "nothing of any kind matched that ref" },
    examples: ["liveone owner show kutis", "liveone owner show 13"],
  },
  transfer: {
    name: "transfer",
    summary:
      "Move devices/areas/dashboards to a new owner, and share them back — one transaction.",
    when:
      "Reach for this when a site changes hands. 🛑 Read access is DERIVED from ownership plus\n" +
      "dashboard grants, so the moment ownership moves the outgoing owner loses access — and\n" +
      "granting is itself an owner-side action. Transfer and share-back therefore happen in ONE\n" +
      "server-side transaction: either both, or neither.",
    description:
      "The share-back is checked, not assumed: the server REFUSES a transfer after which a\n" +
      "share-back recipient could not read a transferred device, and names the devices. That is\n" +
      "what catches the common mistake of moving devices without the dashboard that shows them.\n" +
      "\n" +
      "`--cascade` expands an area to its member DEVICES only. Dashboards are never swept in\n" +
      "implicitly — they are what grants are written against, so moving one silently would change\n" +
      "who can see what. Any dashboard referencing a moving device is listed in the plan instead.",
    mutates: true,
    args: [
      {
        name: "to",
        required: true,
        help: "The new owner: user_… id, email, or username",
      },
    ],
    flags: {
      ...BASE_URL_FLAG,
      devices: {
        type: "string",
        placeholder: "a,b",
        help: "Devices to move (comma-separated refs)",
      },
      areas: {
        type: "string",
        placeholder: "a,b",
        help: "Areas to move (comma-separated refs)",
      },
      dashboards: {
        type: "string",
        placeholder: "a,b",
        help: "Dashboards to move (comma-separated refs)",
      },
      cascade: {
        type: "boolean",
        help: "Also move each named area's member devices",
      },
      shareBack: {
        type: "string",
        placeholder: "user",
        help: "Users to grant on the moved dashboards (comma-separated); defaults to you",
      },
      noShareBack: {
        type: "boolean",
        help: "Transfer with NO share-back — only the new owner and admins will see it",
      },
      role: {
        type: "string",
        placeholder: "viewer",
        values: ["viewer", "admin"],
        help: "Grant role for the share-back (default: viewer)",
      },
      force: {
        type: "boolean",
        help: "Proceed even if the share-back would not restore read access",
      },
    },
    exitCodes: { 1: "the server refused the transfer (the reason says why)" },
    examples: [
      "liveone owner transfer karoline@example.com --areas=kutis --cascade --dashboards=kew,kew-stacked",
      "liveone owner transfer karoline@example.com --areas=kutis --cascade --dashboards=kew --apply",
    ],
  },
} satisfies Record<string, CommandSpec>;
