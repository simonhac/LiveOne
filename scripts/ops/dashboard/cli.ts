/**
 * The `dashboard` domain of the `liveone` CLI — inspect and edit stored dashboard documents
 * (`dashboards.doc`, the v4 node tree).
 *
 * A COMPOSABLE module, not an entrypoint: it exports the spec and a dispatcher, and
 * `scripts/ops/liveone.ts` mounts it. That is what lets one CLI carry several domains
 * (`liveone dashboard show`, and later `liveone device …`) instead of one npm script per domain.
 * Deliberately no `run()` here — a module with an entrypoint cannot be composed, and importing it
 * would execute it.
 *
 * Driven by the shared harness in `lib/cli/`, so it gets arity-aware parsing, `--help` at every
 * level, `--format human|json`, the dry-by-default write gate, the exit-code vocabulary and
 * stdout/stderr separation for free — and a future MCP server renders its tool list from this same
 * declaration (`lib/cli/tool-schema.ts`).
 *
 * See `docs/migrations.md` § "Data & config-document migrations".
 *
 * Split by role: `plumbing.ts` (doc reads, node addressing, the read-modify-write envelope),
 * `flags.ts` (shared arg/flag groups), `handlers.ts` (the verbs + dispatcher), `db.ts` and
 * `transport.ts` (the two transports). This file is the command tree, and the domain's entry point.
 */
import { z } from "zod";
import { defineCommand, type CommandSpec } from "@/lib/cli/cli";
import { DELETE_SPEC, LINK_SPEC, SHARE_SPEC } from "./sharing";
import {
  DASH_ARG,
  ENVELOPE_FLAGS,
  NODE_ARG,
  POSITION_FLAGS,
  TRANSPORT_FLAGS,
} from "./flags";

export const dashboardCommand = defineCommand({
  name: "dashboard",
  summary:
    "Inspect and edit stored dashboard documents (`dashboards.doc`, the v4 node tree).",
  when:
    "Reach for this to read or change what a dashboard SHOWS — its cards, groups, layout and\n" +
    "which area or device each is bound to — directly in the database. For a card-type rename\n" +
    "across every stored document use `scripts/utils/migrate-card-type.ts` instead; for the\n" +
    "areas and devices a dashboard refers to, edit those through the app.",
  description:
    "The connection comes from MIGRATE_DATABASE_URL and nothing else — deliberately NOT the\n" +
    "ambient PLANETSCALE_DATABASE_URL, because the durable target is PROD and 'which database am\n" +
    "I pointed at' must never be answered by whatever happens to be in .env.local. Every command\n" +
    "prints `target: database as user @ host` on stderr before doing anything: READ THAT LINE\n" +
    "before you pass --apply. There is deliberately no 'am I on prod' auto-detection — a freshly\n" +
    "minted `pscale role` connects as pscale_api_… and carries no branch id, so the usual check\n" +
    "would report a confident 'not prod' for the exact connection this tool normally targets. A\n" +
    "false reassurance is worse than none; the printed identity is the check.\n" +
    "\n" +
    "🛑 Durable edits go to PROD. `dashboards` is a config table the 2-hourly prod→dev sync\n" +
    "refreshes, so a dev-only edit is reverted within the hour. Rehearse against dev freely.\n" +
    "🛑 n_… node ids are minted per-document per-ENVIRONMENT, so prod and dev drift. Making the\n" +
    "same edit in both means re-running `show` in each — never reuse an id across environments.",
  uses: ["db", "api"],
  subcommands: {
    list: {
      name: "list",
      summary:
        "List dashboards: id, owner, name, slug, revision and card count.",
      when: "Start here when you do not yet know a dashboard's id.",
      flags: {
        ...TRANSPORT_FLAGS,
        owner: {
          type: "string",
          placeholder: "userId",
          help: "Only this owner's dashboards",
        },
      },
      examples: [
        "liveone dashboard list",
        "liveone dashboard list --format json",
      ],
    },

    show: {
      name: "show",
      summary:
        "Render a dashboard's node tree, with the n_… ids edits address.",
      when:
        "Run this before any edit: the n_… ids it prints are the handles every other subcommand\n" +
        "takes, and they are per-environment so they must be read from the database you intend\n" +
        "to change.",
      description:
        "Always renders the NORMALIZED document, so the ids shown are the ids a write would\n" +
        "persist. --format json emits the same normalized doc (or one subtree with --node).",
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        node: {
          type: "string",
          placeholder: "n_id",
          help: "Render only this node's subtree",
        },
      },
      examples: [
        "liveone dashboard show kink",
        "liveone dashboard show db_01kyf18tp3e5brm474zf0fzvkm --node=n_2XRX",
      ],
    },

    validate: {
      name: "validate",
      summary: "Validate a stored dashboard doc, or a doc in a JSON file.",
      when:
        "Use this to find out WHY an edit is being refused, or to check a document you are about\n" +
        "to write from a file.",
      args: [{ ...DASH_ARG, required: false }],
      flags: {
        ...TRANSPORT_FLAGS,
        file: {
          type: "string",
          placeholder: "path",
          help: "Validate this JSON file instead of a stored dashboard",
        },
      },
      exitCodes: { 1: "the document is invalid" },
      examples: [
        "liveone dashboard validate kink",
        "liveone dashboard validate --file=doc.json",
      ],
    },

    rename: {
      name: "rename",
      summary:
        "Change a dashboard's name and/or slug. Metadata only — the doc is untouched.",
      when: "Use this for the dashboard's own name or its /dashboard/{user}/{slug} shortname.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        name: {
          type: "string",
          placeholder: "text",
          help: 'New display name, or "none" to clear it',
        },
        slug: {
          type: "string",
          placeholder: "kebab",
          help: 'New owner-unique shortname, or "none" to clear it',
        },
      },
      examples: [
        "liveone dashboard rename kink --slug=kinkora",
        "liveone dashboard rename kink --name='Kinkora' --apply",
      ],
    },

    duplicate: {
      name: "duplicate",
      summary: "Copy a dashboard to a NEW one — same cards, fresh node ids.",
      when:
        "Use this to fork a dashboard before restyling it, instead of hand-rolling a POST. The\n" +
        "copy is created through the API's full validation and slug rules.",
      description:
        "http transport only. The server re-mints every node id, so n_… ids noted from the SOURCE\n" +
        "do not address nodes in the copy — run `show` on the copy before editing it.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        name: {
          type: "string",
          required: true,
          placeholder: "text",
          help: "Display name for the copy",
        },
        slug: {
          type: "string",
          placeholder: "kebab",
          help: "Owner-unique shortname for the copy (omit for none)",
        },
      },
      examples: [
        'liveone dashboard duplicate daylesford --name="Daylesford (stacked)" --slug=daylesford-stacked',
        'liveone dashboard duplicate kink --name="Kinkora copy" --apply',
      ],
    },

    "add-card": {
      name: "add-card",
      summary: "Insert a card node.",
      when: "Use this to put a new card on a dashboard; `add-group` makes a container instead.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        type: {
          type: "string",
          required: true,
          placeholder: "cardType",
          help: "The card type, e.g. solar, chart, heatmap",
        },
        configJson: {
          type: "string",
          placeholder: "json",
          help: "The card's config, inline",
        },
        configFile: {
          type: "string",
          placeholder: "path",
          help: "The card's config, from a JSON file",
        },
        allowUnknownType: {
          type: "boolean",
          help: "Write a type this build does not know (it renders as a placeholder)",
        },
        ...ENVELOPE_FLAGS,
        ...POSITION_FLAGS,
      },
      examples: [
        "liveone dashboard add-card kink --type=heatmap --device=dv_01kybrhzkmfyxvz63d15rscj19 --after=n_2VF4",
        'liveone dashboard add-card kink --type=chart --config-json=\'{"variant":"lines"}\' --apply',
      ],
    },

    "add-group": {
      name: "add-group",
      summary: "Insert an empty group node.",
      when:
        "Use this for structure — a row of tiles, or an area section. A group with an area and\n" +
        "heading is what used to be called a section; a row group is what used to be a tiles card.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        direction: {
          type: "string",
          values: ["row", "column"],
          help: "Flex direction (default: column)",
        },
        wrap: { type: "boolean", help: "Allow children to wrap" },
        heading: { type: "boolean", help: "Render the bound area's header" },
        ...ENVELOPE_FLAGS,
        ...POSITION_FLAGS,
      },
      examples: [
        "liveone dashboard add-group kink --direction=row --wrap --after=n_CBEX",
        "liveone dashboard add-group kink --area=ar_01kx8km3a3fh5v2csryvhskzep --heading --apply",
      ],
    },

    "remove-node": {
      name: "remove-node",
      summary: "Remove a node and its whole subtree.",
      when: "Removes the node AND everything under it — check `show` first if it is a group.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      flags: { ...TRANSPORT_FLAGS },
      examples: [
        "liveone dashboard remove-node kink n_5CKF",
        "liveone dashboard remove-node kink n_5CKF --apply",
      ],
    },

    "remint-ids": {
      name: "remint-ids",
      summary: "Re-mint every node id in a document (one-time migration).",
      when:
        "A MIGRATION, not an edit: run it once per document to move ids off the retired sequential\n" +
        "form (n_0, n_1, …) onto the random form. Every id changes, so any id noted from an earlier\n" +
        "`show` stops resolving — which is the point, because a sequential id could be RECYCLED onto\n" +
        "a different node after a removal. Structure, refs and config are untouched.",
      mutates: true,
      args: [DASH_ARG],
      flags: { ...TRANSPORT_FLAGS },
      examples: [
        "liveone dashboard remint-ids db_01kyf18tp3e5brm474zf0fzvkm",
        "liveone dashboard remint-ids db_01kyf18tp3e5brm474zf0fzvkm --apply",
      ],
    },

    "move-node": {
      name: "move-node",
      summary: "Move a node, subtree intact and ids preserved.",
      when:
        "Use this to reorder or re-parent. Ids survive the move, so a later edit can still\n" +
        "address the node by the id `show` printed before it.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      flags: { ...TRANSPORT_FLAGS, ...POSITION_FLAGS },
      examples: [
        "liveone dashboard move-node kink n_FS02 --before=n_E7Z1",
        "liveone dashboard move-node kink n_FS02 --parent=n_CBEX --index=0 --apply",
      ],
    },

    "set-prop": {
      name: "set-prop",
      summary:
        "Set or clear a node's envelope props, and a card's type/config.",
      when:
        "Use this to change an existing node in place — bind it to a different device, resize it,\n" +
        "hide it, or replace a card's config. Pass `none` to any property to DELETE that key.",
      mutates: true,
      args: [DASH_ARG, NODE_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        area: {
          type: "string",
          placeholder: "ar_id|none",
          help: "Bind to an area, or none to clear (readability is NOT checked)",
        },
        device: {
          type: "string",
          placeholder: "dv_id|none",
          help: "Bind to a device, or none to clear (readability is NOT checked)",
        },
        hidden: {
          type: "string",
          values: ["true", "false", "none"],
          help: "Set or clear the hidden flag",
        },
        wrap: {
          type: "string",
          values: ["true", "false", "none"],
          help: "Group only: set or clear wrapping",
        },
        heading: {
          type: "string",
          values: ["true", "false", "none"],
          help: "Group only: set or clear the area header",
        },
        direction: {
          type: "string",
          values: ["row", "column", "none"],
          help: "Group only: flex direction, or none to clear",
        },
        columns: {
          type: "string",
          placeholder: "1-12|none",
          help: "Width hint, or none to clear",
        },
        type: {
          type: "string",
          placeholder: "cardType",
          help: "Card only: change the card type",
        },
        config: {
          type: "string",
          values: ["none"],
          help: "Card only: clear the config (use --config-json/--config-file to set)",
        },
        configJson: {
          type: "string",
          placeholder: "json",
          help: "Card only: replace the config, inline",
        },
        configFile: {
          type: "string",
          placeholder: "path",
          help: "Card only: replace the config, from a JSON file",
        },
        allowUnknownType: {
          type: "boolean",
          help: "Allow a --type this build does not know",
        },
      },
      examples: [
        "liveone dashboard set-prop kink n_VX15 --columns=6",
        "liveone dashboard set-prop kink n_VX15 --hidden=none --apply",
      ],
    },
    history: {
      name: "history",
      summary:
        "The dashboard's edit history — who changed it, when, revision by revision.",
      when:
        "Run this before `restore`, and any time an edit surprises you. Every write records a\n" +
        "post-image row, so revision N here IS version N of the document.",
      description:
        "savedBy is a provenance string, not always a person: routes record the caller's Clerk\n" +
        "userId, the CLI records `cli`, scripts `script:<name>`, and the backfill `backfill`.\n" +
        "History is per-environment — the prod→dev sync deliberately does not carry it.",
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        limit: {
          type: "number",
          default: 20,
          schema: z.number().int().min(1).max(500),
          hint: "1–500",
          help: "How many revisions to show, newest first",
        },
      },
      exitCodes: { 1: "no history recorded (run backfill-history)" },
      examples: [
        "liveone dashboard history kink",
        "liveone dashboard history kink --limit=5",
      ],
    },
    restore: {
      name: "restore",
      summary:
        "Restore a recorded revision — as a NEW revision, never a counter rewind.",
      when:
        "The undo. Find the revision with `history`, preview the restore dry, then --apply. The\n" +
        "restore itself is recorded, so history shows what happened and is itself restorable.",
      description:
        "The recorded doc is re-validated against TODAY'S card vocabulary before writing — a\n" +
        "months-old snapshot may name a type this build no longer knows, and restoring it blindly\n" +
        "would write a grey box. A doc that no longer validates is refused with its issues.",
      mutates: true,
      args: [DASH_ARG],
      flags: {
        ...TRANSPORT_FLAGS,
        revision: {
          type: "number",
          required: true,
          schema: z.number().int().min(1),
          hint: "a revision number from `history`",
          help: "The recorded revision to restore",
        },
      },
      examples: [
        "liveone dashboard restore kink --revision=3",
        "liveone dashboard restore kink --revision=3 --apply",
      ],
    },
    "backfill-history": {
      name: "backfill-history",
      summary:
        "Seed a history row for every dashboard whose current revision has none.",
      when:
        "Run ONCE per environment after the revisions writers land, so `restore` has a floor for\n" +
        "documents that predate them. Idempotent — a dashboard already recorded is skipped.",
      description:
        "db transport only: it writes rows the API deliberately has no endpoint for (history is\n" +
        "server-written, not client-supplied). Rows are inserted with savedBy=backfill at each\n" +
        "dashboard's CURRENT revision, ON CONFLICT DO NOTHING.",
      mutates: true,
      flags: { ...TRANSPORT_FLAGS },
      examples: [
        "npm run liveone:dev -- dashboard backfill-history",
        "liveone dashboard backfill-history --via=db --apply",
      ],
    },
    share: SHARE_SPEC,
    link: LINK_SPEC,
    delete: DELETE_SPEC,
  },
} satisfies CommandSpec);

export { runDashboard } from "./handlers";
