/**
 * The `automation` command tree — declaration only, no I/O.
 */
import { type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../shared";
import { AREA_ARG, AUTOMATION_ARG, WEEKDAYS } from "./model";

const TARGET_ARGS = [AREA_ARG, AUTOMATION_ARG];

export const AUTOMATION_SUBCOMMANDS = {
  list: {
    name: "list",
    summary: "Every automation on an area, and what each one does.",
    when: "The first call — `au_` ids are per-environment, so start here before any other verb.",
    description:
      "One line each: id, enabled, a summary of the trigger, name. A row whose stored trigger\n" +
      "could not be parsed shows UNREADABLE rather than a guess — it is still listable, and still\n" +
      "deletable, which is the point.",
    args: [AREA_ARG],
    flags: { ...BASE_URL_FLAG },
    exitCodes: { 1: "the area has no automations" },
    examples: ["liveone automation list daylesford"],
  },

  show: {
    name: "show",
    summary:
      "One automation in full, including the last decision the evaluator made.",
    when:
      "Reach for this to answer 'why didn't it run last Thursday'. For an exercise rule the\n" +
      "outcome, the reason and the load evidence are all recorded on the row.",
    description:
      "There is no GET-by-id route, so the automation is resolved from the area's list — which is\n" +
      "why this verb takes the area as well.",
    args: TARGET_ARGS,
    flags: { ...BASE_URL_FLAG },
    examples: ["liveone automation show daylesford 'Generator exercise'"],
  },

  "create-exercise": {
    name: "create-exercise",
    summary:
      "Schedule a generator exercise run — unless it has already run under load recently.",
    when:
      "Reach for this for anti-wet-stacking: a diesel that idles for weeks glazes its bores. The\n" +
      "rule fires on a weekly wall-clock slot and SKIPS itself when the engine has already done\n" +
      "real work, so a generator in normal use is never exercised unnecessarily.",
    description:
      "🛑 This creates something that STARTS AN ENGINE, on a schedule, unattended. Dry-run is the\n" +
      "default; read the printed rule before `--apply`.\n" +
      "\n" +
      "Three points are involved and they are not interchangeable:\n" +
      "  --derivation    the run detector, which answers 'is it running' and 'did it run'\n" +
      "  --load-point    a power point in WATTS (negative = import) that says how HARD it ran;\n" +
      "                  the DeepSea controller has no CTs, so load is read from the inverter\n" +
      "  --action-point  the writable run-request point the run is commanded through\n" +
      "\n" +
      "A point is a pt_… id, a logical path on one of the AREA's devices, or the qualified form\n" +
      "`<device>:<path>`. The qualified form is not a nicety: only the DERIVATION has to live in\n" +
      "the area, so the run-request point is routinely on a device that is not a member of it.\n" +
      "\n" +
      "The rule never dispatches while a run is already in progress: a second request would\n" +
      "recompute the hub's stop deadline from now and truncate the run someone else asked for.\n" +
      "\n" +
      "Times are the AREA's local wall clock and stay that way across daylight saving.",
    mutates: true,
    args: [AREA_ARG],
    flags: {
      ...BASE_URL_FLAG,
      derivation: {
        type: "string",
        required: true,
        placeholder: "dx_|role",
        help: "The run detector: dx_… id, its name, or its role (e.g. generator)",
      },
      loadPoint: {
        type: "string",
        required: true,
        placeholder: "path|pt_",
        help: "Power point in W used to judge load (e.g. bidi.grid/power, or dev:bidi.grid/power)",
      },
      actionPoint: {
        type: "string",
        required: true,
        placeholder: "path|pt_",
        help: "Writable run-request point, often on another device (e.g. generator:source.generator.control.request/duration)",
      },
      weekdays: {
        type: "string",
        required: true,
        placeholder: "thu",
        help: `Comma-separated: ${WEEKDAYS.join(", ")}`,
      },
      time: {
        type: "string",
        required: true,
        placeholder: "09:00",
        help: "24-hour local wall-clock start time (not 02:00–02:59)",
      },
      minutes: {
        type: "number",
        required: true,
        placeholder: "30",
        help: "How long to run for. Must be > 0 — 0 is a STOP, not a run",
      },
      name: { type: "string", help: "Name (default: 'Generator exercise')" },
      graceMinutes: {
        type: "number",
        help: "How long a missed slot stays due before it is written off (default 180)",
      },
      minMinutes: {
        type: "number",
        help: "Continuous loaded minutes that count as already exercised (default 30)",
      },
      minLoadKw: {
        type: "number",
        help: "Load floor in kW — an idle run does not clear wet stacking (default 1.5)",
      },
      dipSeconds: {
        type: "number",
        help: "Brief sub-threshold dips bridged rather than splitting a stretch (default 180)",
      },
      withinDays: {
        type: "number",
        help: "How far back to look for such a run (default 7)",
      },
    },
    exitCodes: { 1: "the server refused the rule (422) — nothing was written" },
    examples: [
      "liveone automation create-exercise daylesford --derivation=generator " +
        "--load-point=bidi.grid/power " +
        "--action-point='Daylesford Generator':source.generator.control.request/duration " +
        "--weekdays=thu --time=09:00 --minutes=30",
    ],
  },

  enable: {
    name: "enable",
    summary: "Re-enable a disabled automation.",
    when:
      "Re-enabling an exercise rule inside a slot it has already dealt with does NOT give it a\n" +
      "second chance to fire — the consumed-slot key survives the toggle, by design.",
    mutates: true,
    args: TARGET_ARGS,
    flags: { ...BASE_URL_FLAG },
  },

  disable: {
    name: "disable",
    summary: "Stop an automation being evaluated, without deleting it.",
    when:
      "The reversible way to park a rule — useful before site work, when an unattended engine\n" +
      "start would be unwelcome.",
    mutates: true,
    args: TARGET_ARGS,
    flags: { ...BASE_URL_FLAG },
  },

  delete: {
    name: "delete",
    summary: "Delete an automation.",
    when: "Permanent. `disable` is the reversible option and is almost always the one you want.",
    mutates: true,
    args: TARGET_ARGS,
    flags: { ...BASE_URL_FLAG },
  },
} satisfies Record<string, CommandSpec>;
