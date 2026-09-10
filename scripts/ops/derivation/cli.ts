/**
 * The `derivation` domain of the `liveone` CLI — config that computes a new signal from existing
 * points (clean-sheet §4.4): run detectors, and the HWS thermal model.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * Http-only, and every verb speaks the v4 API: there is no `--via=db`, because everything that makes
 * a derivation correct is server-side. `ensureRunDetector` decides whether the wiring is legal at
 * all (`owner-role-taken`: two detectors for one role resolving to the same OWNER device would
 * fight over one `<stem>/running` point — an invariant no index can express), the authorization is
 * computed from the derivation's own device set, and the recompute is a delete-and-reinsert under
 * an advisory lock. A db leg would re-implement all three to be equally right, and would get the
 * interesting cases wrong.
 *
 * ## Why this domain exists
 *
 * The run-tracking stack shipped with no CLI at all, so creating a detector meant either a seed
 * script with hand-copied point uuids or a raw `liveone api` POST — which is exactly how a detector
 * came to exist on dev and not on prod with nothing to notice the difference. Two ergonomics here
 * are the point rather than sugar:
 *
 *   - `--signal` takes a LOGICAL PATH (`load.ev/power`), resolved on the device the detector is
 *     about. Pinning the wrong `pt_` id by hand is silent — you get a detector that simply never
 *     fires.
 *   - `recompute` has no unscoped form. It posts to `…/derivations/{dx_}/recompute`, where the scope
 *     is a path segment; the cron's optional-filter twin is what a full-range unscoped regenerate
 *     was reachable through, and it collapsed 71 dev rows to 3.
 *
 * ## Addressed by identity, not by placement
 *
 * 🛑 No verb takes an `<area>`. A derivation's site is DERIVED from its source points, so there is
 * no area to name and none is accepted: `create` names the DEVICE the detector is about, and every
 * other verb names the derivation itself. `--device`/`--area` narrow the fleet-wide listing when a
 * bare role would name more than one row; they are not the address, and a ref that needs one says
 * so rather than guessing.
 *
 * Split by role: `model.ts` (vocabulary + resolution), `flags.ts` (shared flag groups),
 * `handlers.ts` (the verbs + dispatcher). This file is the spec, and the domain's entry point.
 */
import { defineCommand, type CommandSpec } from "@/lib/cli/cli";
import { BASE_URL_FLAG } from "../shared";
import {
  DERIVATION_ARG,
  DEVICE_ARG,
  KINDS,
  KNOBS,
  KNOB_FLAGS,
  NARROW_FLAGS,
  SCOPE_ARG,
  TRACKABLE_ROLES,
} from "./model";
import { WINDOW_FLAGS } from "./flags";

export { runDerivation } from "./handlers";

export const derivationCommand = defineCommand({
  name: "derivation",
  summary:
    "Derived signals — run detectors and the HWS model: list, create, enable, recompute, delete.",
  when:
    "Reach for this when a device's RUNS are the question — whether the generator/EV-charge detector\n" +
    "exists, what it has detected, or rebuilding its history after a config change. The `runs` card on\n" +
    "a dashboard shows what a detector here produced; `area` and `device` show the inputs it reads.",
  description:
    "Http-only: every verb calls the deployed v4 API as you (`liveone auth login`), and prints\n" +
    "`target: <origin> as <you>` on stderr first — read it to know which environment answered.\n" +
    "A derivation's SITE is DERIVED from its source points, not configured: the device that owns its\n" +
    "energy point (else its signal point) is the device it is addressed by, so there is no placement\n" +
    "to get wrong and no area to name. `create` refuses only if that device already has a detector\n" +
    "for the same role. Access is checked against EVERY device a derivation touches — a detector\n" +
    "whose signal and energy sit on different devices needs write on both. Ids are per-environment.",
  uses: ["api"],
  subcommands: {
    list: {
      name: "list",
      summary:
        "The derivations you can read: id, kind, role, enabled, devices, sources.",
      when: "Start here — to find a dx_… id, or to check whether a detector exists at all.",
      description:
        "Fleet-wide by default: the collection returns every derivation you can read, so 'which\n" +
        "detectors exist anywhere' is one call. Narrow it with a positional scope (resolved as a\n" +
        "DEVICE first, then as an area — every device has an area of one with the same name) or\n" +
        "with the explicit --device/--area flags. Access is all-or-nothing per derivation: one\n" +
        "whose device set you cannot fully read is absent rather than partially shown.",
      args: [SCOPE_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...NARROW_FLAGS,
        kind: {
          type: "string",
          values: KINDS,
          help: "Only this kind of derivation",
        },
        role: {
          type: "string",
          values: TRACKABLE_ROLES,
          help: "Only detectors for this role",
        },
        enabled: { type: "boolean", help: "Only enabled derivations" },
        disabled: { type: "boolean", help: "Only disabled derivations" },
      },
      exitCodes: { 1: "nothing matched" },
      examples: [
        "liveone derivation list",
        "liveone derivation list daylesford",
        "liveone derivation list --role=generator --disabled",
        "liveone derivation list --format json",
      ],
    },
    create: {
      name: "create",
      summary: "Add a derivation to a device.",
      when:
        "Use this to start tracking a device's runs — a generator, or an EV charger. For the HWS\n" +
        "thermal model pass --kind=hws-model, which takes no points (it finds its own).",
      description:
        "<device> is what the detector is ABOUT: it is the scope --signal/--energy resolve in, and\n" +
        "(via its points) what the derivation ends up addressed by. It is not a placement — the\n" +
        "server derives the site from the wiring either way, so naming a device whose points you\n" +
        "then do not use simply resolves nothing.\n" +
        "\n" +
        "--signal/--energy take a LOGICAL PATH (`load.ev/power`) on <device>, a qualified\n" +
        "`<other-device>:<path>` for the cross-device case, or a pt_… id; prefer a path, since a\n" +
        "mis-pinned uuid fails silently — the detector simply never fires. Write access is required\n" +
        "on EVERY device the points land on, not just one of them.\n" +
        "\n" +
        "One of --upper/--lower is required: they are the threshold the run is detected against.\n" +
        "Every OTHER knob is sparse by contract — a flag you do not pass is not written, so it\n" +
        "inherits the role's default (lib/run-tracking/defaults.ts) as those defaults evolve.\n" +
        "Passing a value equal to today's default is therefore NOT a no-op; it pins it.\n" +
        "\n" +
        "--energy is optional and its absence is legal: a detector with no cumulative energy\n" +
        "counter still records duration and signal statistics, and the runs card drops the kWh,\n" +
        "cost, emissions and renewable columns rather than showing them empty.",
      mutates: true,
      args: [DEVICE_ARG],
      flags: {
        ...BASE_URL_FLAG,
        kind: {
          type: "string",
          values: KINDS,
          default: "run-detector",
          help: "What sort of derived signal",
        },
        role: {
          type: "string",
          values: TRACKABLE_ROLES,
          help: "run-detector only: which role's runs these are",
        },
        name: {
          type: "string",
          placeholder: "text",
          help: "Display name (default: '<role> runs')",
        },
        signal: {
          type: "string",
          placeholder: "path|pt_",
          help: "run-detector only: the series to follow, e.g. load.ev/power",
        },
        energy: {
          type: "string",
          placeholder: "path|pt_",
          help: "Optional cumulative energy counter, for per-run kWh",
        },
        ...KNOB_FLAGS,
      },
      exitCodes: {
        1: "the server refused the derivation (the reason says why)",
      },
      examples: [
        "liveone derivation create kutis --role=ev --name='EV charging' --signal=load.ev/power --upper=100 --delay-off=300",
        "liveone derivation create kutis --role=ev --signal=load.ev/power --upper=100 --apply",
        "liveone derivation create 14 --role=generator --signal=source.generator/power --energy=1:source.generator/energy.total --upper=500 --apply",
        "liveone derivation create kink --kind=hws-model --apply",
      ],
    },
    set: {
      name: "set",
      summary:
        "Change a derivation's threshold params, its boundary point, or rename it.",
      when:
        "Use this when a detector is firing wrongly — most often when it FRAGMENTS one long run into\n" +
        "many short ones, which means --delay-off is at or below the point's sample interval.",
      description:
        "Params are MERGED into what is stored, then sent as a whole object (the API replaces\n" +
        "`params` wholesale, and a blind replace would silently drop the knobs you did not mention).\n" +
        "Use --unset to remove a pinned knob so it goes back to inheriting the role default.\n" +
        "\n" +
        "🛑 This does NOT rewrite history. Existing intervals were detected under the OLD params and\n" +
        "stay exactly as they were until you `recompute` the window you care about.\n" +
        "\n" +
        "The signal and energy points are deliberately not editable here: re-pointing a detector\n" +
        "changes what its already-stored rows MEAN, and those rows carry the old signal's unit with\n" +
        "no way to know they predate the change. That is a considered manual operation, not a flag.\n" +
        "--boundary is the ONE exception, and it is safe in exactly the way the others are not: the\n" +
        "boundary point does not change what the stored numbers measure, only where two adjacent\n" +
        "runs are divided. It resolves against the devices this derivation already touches; a\n" +
        "qualified `<device>:<path>` reaches elsewhere and WIDENS the device set, so write access is\n" +
        "then required on that device too.",
      mutates: true,
      args: [DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...NARROW_FLAGS,
        ...KNOB_FLAGS,
        name: { type: "string", placeholder: "text", help: "Rename it" },
        boundary: {
          type: "string",
          placeholder: "path|pt_",
          help: "run-detector only: the control point whose edges cut runs apart",
        },
        clearBoundary: {
          type: "boolean",
          help: "Remove the boundary point, so nothing forces a run to end",
        },
        unset: {
          type: "string",
          repeatable: true,
          placeholder: "knob",
          values: KNOBS.map(([flag]) => flag),
          help: "Drop a pinned knob, so it inherits the role default again",
        },
      },
      exitCodes: { 1: "nothing to change" },
      examples: [
        "liveone derivation set ev --delay-off=900",
        "liveone derivation set ev --delay-off=900 --apply",
        "liveone derivation set generator --device=daylesford --unset=hysteresis --apply",
        "liveone derivation set dx_01k9y6vdqefyz8p4wsy5j5hgcx --boundary=source.generator.control.request/duration --apply",
      ],
    },
    enable: {
      name: "enable",
      summary: "Re-enable a derivation, so it is recomputed again.",
      when: "Use this after a `disable`, once whatever was wrong with its inputs is fixed.",
      mutates: true,
      args: [DERIVATION_ARG],
      flags: { ...BASE_URL_FLAG, ...NARROW_FLAGS },
      examples: ["liveone derivation enable ev --apply"],
    },
    disable: {
      name: "disable",
      summary:
        "Stop a derivation being recomputed. Its existing rows are untouched.",
      when:
        "This is the safe lever, and the reversible one: a disabled derivation stops being\n" +
        "recomputed and stops advertising its capability, while its history stays exactly as it was.\n" +
        "It is also the required first step of a `delete` — deliberately, so the thing is watched\n" +
        "stopping before it is destroyed.",
      mutates: true,
      args: [DERIVATION_ARG],
      flags: { ...BASE_URL_FLAG, ...NARROW_FLAGS },
      examples: ["liveone derivation disable ev --apply"],
    },
    delete: {
      name: "delete",
      summary: "Destroy a derivation, and every interval it ever produced.",
      when:
        "Use this only for a detector that should never have existed — a duplicate, or one wired to\n" +
        "the wrong device. To stop a detector you still want the history of, use `disable`.",
      description:
        "🛑 `derived_intervals` CASCADEs: deleting a derivation destroys every run it ever recorded,\n" +
        "and a recompute afterwards can only rebuild what the underlying readings still cover.\n" +
        "\n" +
        "Two interlocks, and only one of them is waivable. The derivation must ALREADY be disabled —\n" +
        "--force does not waive that, because disabling is one reversible command and it makes you\n" +
        "watch the thing stop first. Then anything still relying on it (its intervals, an hws model's\n" +
        "output point, an automation whose trigger names it) refuses the delete and NAMES what would\n" +
        "break; --force is your answer to that list, and the result reports what it overrode.",
      mutates: true,
      args: [DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...NARROW_FLAGS,
        force: {
          type: "boolean",
          help: "Proceed even though something still relies on it (does NOT waive the disabled-first interlock)",
        },
      },
      exitCodes: { 1: "the server refused the delete (the reason names what)" },
      examples: [
        "liveone derivation delete dx_01k9y6vdqefyz8p4wsy5j5hgcx",
        "liveone derivation delete dx_01k9y6vdqefyz8p4wsy5j5hgcx --apply",
        "liveone derivation delete dx_01k9y6vdqefyz8p4wsy5j5hgcx --force --apply",
      ],
    },
    recompute: {
      name: "recompute",
      summary: "Rebuild ONE derivation's intervals over a window.",
      when:
        "Use this to backfill history for a detector you just created, or to rebuild after changing\n" +
        "its params. The minutely cron already heals the trailing 6 hours, so this is for anything\n" +
        "older than that.",
      description:
        "🛑 regenerate and delete are DELETE-AND-REINSERT. That is safe here only because the\n" +
        "derivation is named in the request path, so this verb has no unscoped form — unlike the\n" +
        "cron's twin, whose filter is optional and through which a full-range unscoped regenerate\n" +
        "once collapsed 71 rows to 3.\n" +
        "\n" +
        "No window means ALL of this detector's history. A long span may exceed the route's 300s\n" +
        "budget; run it in --last=30d slices if so (the server chunks at 14 days internally and\n" +
        "retries transient database errors, so a re-run is cheap and safe to repeat).",
      mutates: true,
      args: [DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...NARROW_FLAGS,
        ...WINDOW_FLAGS,
        action: {
          type: "string",
          values: ["regenerate", "aggregate", "delete"],
          default: "regenerate",
          help: "regenerate = purge then rebuild; aggregate = rebuild in place; delete = purge only",
        },
      },
      examples: [
        "liveone derivation recompute ev --device=kutis --start=2026-07-06 --end=2026-09-01",
        "liveone derivation recompute ev --last=30d --apply",
      ],
    },
    intervals: {
      name: "intervals",
      summary: "The rows a derivation has produced — runs, newest first.",
      when:
        "Use this to check what a detector actually found: after a create, after a backfill, or when\n" +
        "a dashboard's runs card looks wrong and you want the numbers behind it.",
      description:
        "Raw values, not the display strings the dashboard card's own endpoint serves — ISO instants\n" +
        "and numbers, with the unit each signal statistic is in carried PER ROW (a window can\n" +
        "straddle a detector re-point and hold two units).\n" +
        "A run belongs to a window if it STARTED in it, which is the same rule `recompute` deletes\n" +
        "by — so these are exactly the rows a recompute over the same window would replace.",
      args: [DERIVATION_ARG],
      flags: {
        ...BASE_URL_FLAG,
        ...NARROW_FLAGS,
        ...WINDOW_FLAGS,
        limit: {
          type: "number",
          placeholder: "n",
          help: "Rows to return, max 500 (default 100)",
        },
        offset: { type: "number", placeholder: "n", help: "Skip this many" },
      },
      exitCodes: { 1: "no intervals in the window" },
      examples: [
        "liveone derivation intervals ev --device=kutis --last=60d",
        "liveone derivation intervals ev --last=7d --format json",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
