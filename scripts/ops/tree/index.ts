import {
  defineCommand,
  EXIT,
  failWith,
  type CommandSpec,
  type Ctx,
} from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { BASE_URL_FLAG } from "../shared";
import type { TreeInventory } from "@/lib/inventory/types";
import { renderTree } from "./render";

export const treeCommand = defineCommand({
  name: "tree",
  summary:
    "Users → areas → devices, with derivations, automations and provenance.",
  description:
    "Read-only. Defaults to your owned inventory, including every status and empty areas. Use --admin for the fleet and ownerless objects. Points and bindings are summarized; helper outputs are expanded. --sharing annotates effective dashboard access and active calendar links, never token values. Historical readings, sessions and commands are not individual tree nodes.",
  uses: ["api"],
  flags: {
    ...BASE_URL_FLAG,
    sharing: {
      type: "boolean",
      help: "Annotate dashboard recipients, effective shared objects and active share/calendar links",
    },
    points: {
      type: "boolean",
      help: "Expand every device's sensor/control points",
    },
    bindings: { type: "boolean", help: "Expand area role-to-point bindings" },
  },
  examples: [
    "liveone tree",
    "liveone tree --admin --sharing",
    "liveone tree --admin --sharing --points --bindings --format=human",
    "liveone tree --admin --format=json",
  ],
} satisfies CommandSpec);

export async function runTree(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const sharing = ctx.flags.sharing === true;
    const data = await s.get<TreeInventory>(
      `/api/v4/tree${sharing ? "?sharing=true" : ""}`,
    );
    if (
      data.version !== 1 ||
      data.sharingIncluded !== sharing ||
      data.scope !== (s.actingAsAdmin ? "fleet" : "own")
    )
      throw failWith(
        EXIT.UPSTREAM,
        "incompatible tree response",
        "the server did not confirm the requested inventory scope",
        "check the deployed build; tree requires the matching server endpoint",
      );
    ctx.emit(data, () =>
      renderTree(data, {
        points: ctx.flags.points === true,
        bindings: ctx.flags.bindings === true,
      }),
    );
    return EXIT.OK;
  });
}
