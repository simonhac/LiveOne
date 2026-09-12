/**
 * The `calendar` command tree — declaration only, no I/O.
 */
import { type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../shared";
import { AREA_ARG } from "../automation/model";

export const CALENDAR_SUBCOMMANDS = {
  list: {
    name: "list",
    summary:
      "Every feed token ever minted for an area, and its subscription URL.",
    when:
      "The first call — and the one that answers 'is this subscription still live'. Revoked and\n" +
      "expired tokens are listed too, with the date each stopped working; a filtered list could\n" +
      "not answer that.",
    description:
      "`last used` is how a forgotten subscription is spotted: a token nothing has fetched in\n" +
      "months is one nobody would miss, and is the safe thing to revoke.",
    args: [AREA_ARG],
    flags: { ...BASE_URL_FLAG },
    exitCodes: { 1: "the area has no calendar tokens" },
    examples: ["liveone calendar list daylesford"],
  },

  mint: {
    name: "mint",
    summary:
      "Create a feed token and print the URL to subscribe a calendar app to.",
    when:
      "One per subscriber, labelled, so revoking one person's access does not break everyone\n" +
      "else's. Reach for this rather than re-sharing an existing URL.",
    description:
      "🛑 The URL IS the credential. A calendar client fetches it unattended for years with no\n" +
      "way to sign in, so there is nothing else to authenticate with — treat it exactly like a\n" +
      "dashboard share link, and use --expires-days for anything temporary.\n" +
      "\n" +
      "The feed carries the area's scheduled automations — when the site INTENDS to run\n" +
      "something — and no readings, no point values, and nothing about what actually happened.\n" +
      "\n" +
      "Two URLs are printed. `webcal://` makes a calendar app SUBSCRIBE (re-fetching hourly);\n" +
      "the `https://` one is a one-time snapshot in most clients, and is what curl wants.",
    mutates: true,
    args: [AREA_ARG],
    flags: {
      ...BASE_URL_FLAG,
      label: {
        type: "string",
        required: true,
        placeholder: "simon's phone",
        help: "Who or what this URL is for — required, so it can be revoked knowingly",
      },
      expiresDays: {
        type: "number",
        placeholder: "90",
        help: "Stop working after this many days (default: never)",
      },
    },
    examples: [
      "liveone calendar mint daylesford --label='simon iphone' --apply",
    ],
  },

  revoke: {
    name: "revoke",
    summary: "Stop a feed token working.",
    when:
      "Immediate and permanent — there is no un-revoke, and the subscriber's calendar simply\n" +
      "stops updating (most clients say nothing). Mint a replacement rather than reviving one.",
    mutates: true,
    args: [
      AREA_ARG,
      {
        name: "token",
        required: true,
        help: "The token itself, or its label",
      },
    ],
    flags: { ...BASE_URL_FLAG },
    exitCodes: { 1: "no live token matched" },
    examples: ["liveone calendar revoke daylesford 'simon iphone' --apply"],
  },
} satisfies Record<string, CommandSpec>;
