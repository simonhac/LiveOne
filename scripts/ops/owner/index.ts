/**
 * `liveone owner` — who owns what, and moving it.
 *
 * 🛑 Ownership is not a label; it is the thing that carries data access. `requireDeviceAccess` is
 * `isAdmin || isOwner || isPublic`, and the per-device viewer grant died with `user_systems` in
 * migration 0045 — so a non-owner reaches a device only through a dashboard GRANT whose doc
 * references it. Transferring ownership is therefore the moment the previous owner stops being able
 * to see their own site, which is why `transfer` carries the share-back with it in one transaction
 * rather than leaving it as a second call.
 *
 * Split by role: `model.ts` (resolution, cascade, doc-ref scan), `spec.ts` (the command tree),
 * `handlers.ts` (the verbs + dispatcher).
 */
import { defineCommand, type CommandSpec } from "@/lib/cli/cli";
import { OWNER_SUBCOMMANDS } from "./spec";

export { runOwner } from "./handlers";

export const ownerCommand = defineCommand({
  name: "owner",
  summary:
    "Who owns devices, areas and dashboards — and how to hand them over.",
  when:
    "Reach for this when something changes hands. For what an area is MADE of use `area`; for\n" +
    "what a dashboard shows use `dashboard`.",
  description:
    "Http-only, and admin-only for the write: every verb calls the deployed API as you and prints\n" +
    "`target: <origin> as <you>` on stderr first.\n" +
    "\n" +
    "🛑 `transfer` moves ownership AND writes the share-back grants in ONE server-side\n" +
    "transaction, and the server refuses a transfer after which a share-back recipient could not\n" +
    "read a transferred device. Ownership carries access; handing it over without the grant is how\n" +
    "someone loses sight of their own site.",
  uses: ["api"],
  subcommands: OWNER_SUBCOMMANDS,
} satisfies CommandSpec);
