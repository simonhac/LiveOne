/**
 * The `area devices` and `area role` command trees.
 *
 * Specs only, no I/O: `--help`, the parser and the generated reference all derive from this one
 * declaration, so a documented flag cannot drift from an accepted one.
 */
import { type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../../shared";

const AREA_ARG = {
  name: "area",
  required: true,
  help: "An area: its ar_… id, integer handle, or display name",
} as const;

export const DEVICES_SPEC = {
  name: "devices",
  summary: "Which devices an area is made of (writes: add, remove, set).",
  when:
    "Membership is the POOL a binding may draw from — a point can only fill a role slot if its\n" +
    "device is already a member. So this comes first, and `area role` picks within it.",
  subcommands: {
    list: {
      name: "list",
      summary: "The area's member devices.",
      args: [AREA_ARG],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone area devices list kew"],
    },
    add: {
      name: "add",
      summary: "Add one or more devices to the area, keeping the rest.",
      when: "Adding is the safe direction: it grows the pool and cannot orphan a binding.",
      mutates: true,
      args: [
        AREA_ARG,
        {
          name: "device",
          required: true,
          variadic: true,
          help: "Devices to add",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: {
        1: "the server refused the membership (the reason says why)",
      },
      examples: [
        "liveone area devices add kew 10002",
        "liveone area devices add kew 10002 --apply",
      ],
    },
    remove: {
      name: "remove",
      summary: "Remove devices from the area — and their bindings with them.",
      when:
        "🛑 Removing a member DELETES that member's bindings. This verb names them before it does,\n" +
        "and refuses to proceed silently.",
      mutates: true,
      args: [
        AREA_ARG,
        {
          name: "device",
          required: true,
          variadic: true,
          help: "Devices to remove",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: {
        1: "the server refused the membership (the reason says why)",
      },
      examples: ["liveone area devices remove kew 10002 --apply"],
    },
    set: {
      name: "set",
      summary: "Declare the exact membership — anything omitted is removed.",
      when:
        "The full-replace form, matching the route. Prefer `add`/`remove` unless you genuinely mean\n" +
        "'these and only these'.",
      mutates: true,
      args: [
        AREA_ARG,
        {
          name: "device",
          required: true,
          variadic: true,
          help: "The complete membership",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: {
        1: "the server refused the membership (the reason says why)",
      },
      examples: ["liveone area devices set kew 13 10002 --apply"],
    },
  },
} satisfies CommandSpec;

export const ROLE_SPEC = {
  name: "role",
  summary:
    "Which point fills an area's (role, metric) slot, and in what order (writes: set, clear).",
  when:
    "Reach for this when an area renders a card empty, or a metric it should have is missing —\n" +
    "most often because the device is a member but nothing binds its points to a role.",
  description:
    "A binding is AREA-SCOPED ROLE RESOLUTION, not point metadata: it says which point fills\n" +
    "`grid/rate` IN THIS AREA. The same point may be bound in one area and unbound in another.\n" +
    "Priority is the slot's selection order, and `set` takes it from ARGUMENT ORDER.\n" +
    "\n" +
    "What priority orders is points that MEASURE THE SAME THING — same logical path, same\n" +
    "metric. Several points with DIFFERENT paths in one slot (load.hvac, load.pool, load.ev)\n" +
    "all serve; they are circuits, not rivals. Two on the SAME path are a fallback chain: the\n" +
    "first serves the area's history, charts and Sankey, and the rest stand by in the live map,\n" +
    "taking over if it goes quiet for 15 minutes or its point goes inactive.",
  subcommands: {
    list: {
      name: "list",
      summary: "The area's role→point bindings, grouped by slot.",
      args: [AREA_ARG],
      flags: {
        ...BASE_URL_FLAG,
        points: {
          type: "boolean",
          help: "Also list every bindable point on the area's devices, marking which are unbound",
        },
      },
      examples: [
        "liveone area role list kew",
        "liveone area role list kew --points",
      ],
    },
    set: {
      name: "set",
      summary:
        "Fill one (role, metric) slot — priority follows argument order.",
      when:
        "Replaces THAT SLOT and leaves every other slot untouched. Naming several points sets the\n" +
        "slot's whole priority order in one write, which is how a fallback chain is expressed —\n" +
        "first argument preferred. Two points on the same logical path fall back; two on different\n" +
        "paths both serve.",
      mutates: true,
      args: [
        AREA_ARG,
        {
          name: "role",
          required: true,
          help: "e.g. grid, solar, battery, load, ev",
        },
        {
          name: "metric",
          required: true,
          help: "e.g. rate, value, energy, power, proportion",
        },
        {
          name: "point",
          required: true,
          variadic: true,
          help: "Points, highest priority first: pt_ id, logicalPath, or device:logicalPath",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: { 1: "the server refused the binding (the reason says why)" },
      examples: [
        "liveone area role set kew grid rate 'amber:bidi.grid.import/rate'",
        "liveone area role set kew grid rate 'amber:bidi.grid.import/rate' 'amber:bidi.grid.export/rate' --apply",
      ],
    },
    clear: {
      name: "clear",
      summary: "Empty a (role, metric) slot, or every slot of a role.",
      when:
        "Give a role alone to clear all of its metrics; give both to clear one slot. The area falls\n" +
        "back to union-default resolution for whatever is cleared.",
      mutates: true,
      args: [
        AREA_ARG,
        { name: "role", required: true, help: "The role to clear" },
        {
          name: "metric",
          required: false,
          help: "Optional: just this metric of that role",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      exitCodes: { 1: "the server refused the change (the reason says why)" },
      examples: [
        "liveone area role clear kew grid rate --apply",
        "liveone area role clear kew grid --apply",
      ],
    },
  },
} satisfies CommandSpec;
