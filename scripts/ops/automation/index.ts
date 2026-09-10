/**
 * `liveone automation` — the deferred-action rules the minutely cron evaluates.
 *
 * Two kinds live in this table and only one is creatable here. A `charge-session` rule is REACTIVE
 * and STOPS something (the EV charge limits, created from the web app); an `exercise` rule is
 * SCHEDULED and STARTS something. `create-exercise` is named for its kind rather than being a
 * generic `create` with a `--kind` flag precisely because of that asymmetry — the verb that starts
 * a diesel engine unattended should say so in its own name.
 *
 * Split by role: `model.ts` (wire shapes, resolution, rendering), `spec.ts` (the command tree),
 * `handlers.ts` (the verbs + dispatcher).
 */
import { defineCommand, type CommandSpec } from "@/lib/cli/cli";
import { AUTOMATION_SUBCOMMANDS } from "./spec";

export { runAutomation } from "./handlers";

export const automationCommand = defineCommand({
  name: "automation",
  summary:
    "Scheduled and reactive rules — including the generator exercise run.",
  when:
    "Reach for this to see or change what fires by itself. For what a run DETECTOR measures use\n" +
    "`derivation`; automations act on what those detectors report.",
  description:
    "Http-only: every verb calls the deployed API as you and prints `target: <origin> as <you>`\n" +
    "on stderr first. There is no --via=db, because the checks that make a deferred command safe\n" +
    "(ownership of the action point, the trigger/action pairing, the load point's unit) are all\n" +
    "server-side — a direct write would store a rule none of them had seen.\n" +
    "\n" +
    "🛑 Writers are dry-run by default. `create-exercise` creates something that starts an engine\n" +
    "on a schedule, with nobody present; read the printed rule before --apply.",
  uses: ["api"],
  subcommands: AUTOMATION_SUBCOMMANDS,
} satisfies CommandSpec);
