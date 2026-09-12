/**
 * `liveone calendar` — the subscribable `.ics` feed of an area's scheduled automations.
 *
 * A domain of its own rather than three more `automation` verbs, because what it manages is a
 * CREDENTIAL, not an automation: `mint`/`revoke` are about who may read the schedule, and would sit
 * beside `create-exercise`/`skip` saying nothing about which of them starts an engine.
 *
 * Split by role: `spec.ts` (the command tree), `handlers.ts` (the verbs + dispatcher).
 */
import { defineCommand, type CommandSpec } from "@/lib/cli/cli";
import { CALENDAR_SUBCOMMANDS } from "./spec";

export { runCalendar } from "./handlers";

export const calendarCommand = defineCommand({
  name: "calendar",
  summary: "Subscribe a calendar app to an area's scheduled automations.",
  when:
    "Reach for this to SEE a schedule in a calendar. To change one use `automation`; for a\n" +
    "quick dated list with no calendar client at all, `automation upcoming` needs no token.",
  description:
    "Http-only, like `automation`: every verb calls the deployed API as you.\n" +
    "\n" +
    "🛑 A feed URL is a bearer credential with no expiry by default, handed to software that will\n" +
    "re-fetch it for years. Mint one per subscriber, label it, and revoke rather than re-share.",
  uses: ["api"],
  subcommands: CALENDAR_SUBCOMMANDS,
} satisfies CommandSpec);
