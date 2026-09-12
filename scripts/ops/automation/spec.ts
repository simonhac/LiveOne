/**
 * The `automation` command tree — declaration only, no I/O.
 */
import { type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../shared";
import { AREA_ARG, AUTOMATION_ARG } from "./model";

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
      "rule fires on a wall-clock slot and SKIPS itself when the engine has already done real\n" +
      "work, so a generator in normal use is never exercised unnecessarily.",
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
      "WHEN it runs is an RFC 5545 subset — --start is the first occurrence and, on its own, the\n" +
      "whole of a one-off; --rrule repeats it:\n" +
      "  --rrule='FREQ=WEEKLY;BYDAY=TH'                 every Thursday\n" +
      "  --rrule='FREQ=WEEKLY;INTERVAL=2;BYDAY=TH'      every second Thursday\n" +
      "  --rrule='FREQ=MONTHLY;BYDAY=1SA'               the first Saturday of each month\n" +
      "  --rrule='FREQ=MONTHLY;BYMONTHDAY=-1'           the last day of each month\n" +
      "Supported parts: FREQ (DAILY|WEEKLY|MONTHLY|YEARLY), INTERVAL, COUNT, UNTIL, BYDAY,\n" +
      "BYMONTHDAY, BYMONTH, BYSETPOS, WKST. Anything else is refused rather than ignored.\n" +
      "--until/--count are sugar folded into the rule, and are mutually exclusive.\n" +
      "\n" +
      "A rule that runs out of occurrences DISABLES itself as it consumes its last slot.\n" +
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
      start: {
        type: "string",
        required: true,
        placeholder: "2026-09-17 09:00",
        help: "First occurrence, local date + 24-hour time (not 02:00–02:59). Alone = a one-off",
      },
      rrule: {
        type: "string",
        placeholder: "FREQ=WEEKLY;BYDAY=TH",
        help: "How it repeats, RFC 5545. Omit for a one-off",
      },
      until: {
        type: "string",
        placeholder: "2026-12-31",
        help: "Stop repeating after this date (needs --rrule; not with --count)",
      },
      count: {
        type: "number",
        placeholder: "6",
        help: "Stop after this many occurrences (needs --rrule; not with --until)",
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
        "--start='2026-09-17 09:00' --rrule='FREQ=WEEKLY;BYDAY=TH' --minutes=30",
      "liveone automation create-exercise daylesford --derivation=generator " +
        "--load-point=bidi.grid/power --action-point=generator:source.generator.control.request/duration " +
        "--start='2026-09-12 09:00' --minutes=30",
    ],
  },

  upcoming: {
    name: "upcoming",
    summary:
      "Every scheduled occurrence on an area, dated, for the next N days.",
    when:
      "The verification tool when you have no calendar client to hand — and the direct way to\n" +
      "answer 'is this actually a one-off, or did I write a standing rule'. Read-only.",
    description:
      "Merges every enabled exercise rule on the area into one dated list, in the AREA's local\n" +
      "time, with EXDATEs already removed and RDATEs already added — i.e. what will really happen,\n" +
      "not what the rule says.",
    args: [AREA_ARG],
    flags: {
      ...BASE_URL_FLAG,
      days: {
        type: "number",
        placeholder: "30",
        help: "How far ahead to look (default 30)",
      },
      all: {
        type: "boolean",
        help: "Include DISABLED rules, marked as such",
      },
    },
    exitCodes: { 1: "nothing is scheduled in the window" },
    examples: ["liveone automation upcoming daylesford --days=90"],
  },

  skip: {
    name: "skip",
    summary:
      "Skip one occurrence of a repeating rule, leaving the rule itself alone.",
    when:
      "'Not next Thursday' — site work, someone on holiday, a generator already booked. The rule\n" +
      "keeps running afterwards; only that one instance is dropped.",
    description:
      "Adds an EXDATE for the named date's occurrence. `upcoming` lists the dates that have one,\n" +
      "and running `skip` on a date that is already skipped is a no-op rather than an error.\n" +
      "\n" +
      "The route replaces the whole trigger, so this re-sends it — but a slot ALREADY dealt with\n" +
      "today stays dealt with, because an exdate-only edit deliberately does not clear the\n" +
      "consumed-slot key. Without that, skipping next week at 09:30 could start the engine a\n" +
      "second time this morning.",
    mutates: true,
    args: TARGET_ARGS,
    flags: {
      ...BASE_URL_FLAG,
      date: {
        type: "string",
        required: true,
        placeholder: "2026-09-24",
        help: "The local date to skip — there must be an occurrence on it",
      },
    },
    exitCodes: { 1: "there is no occurrence on that date" },
    examples: [
      "liveone automation skip daylesford 'Generator exercise' --date=2026-09-24",
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
