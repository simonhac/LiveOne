#!/usr/bin/env tsx
/**
 * liveone — the operator CLI.
 *
 * ONE command with DOMAIN groups beneath it (`liveone dashboard show`), rather than one npm script
 * per domain. The domains coming behind `dashboard` — device values, session logs — are siblings
 * under this root, so there is one thing to learn, one credential, one `--help` tree, and one
 * catalogue for a future MCP server to render from.
 *
 * Each domain lives in its own module and exports a spec plus a dispatcher; none of them owns an
 * entrypoint, because a module with one cannot be composed (and importing it would run it). This
 * file is the only entrypoint.
 *
 *   npm run liveone -- <domain> <command> [options]
 *   npm run liveone -- dashboard show 6
 *
 * Everything the harness (`lib/cli/`) gives every command: `--help` at every level, `--format
 * human|json` (human at a terminal, json when piped), data on stdout with diagnostics on stderr,
 * the shared exit vocabulary, and — for writers — dry-run by default with `--apply`, which off a
 * terminal additionally requires `--yes` because a prompt with no terminal is a hang.
 */
import { defineCommand, run, failWith, EXIT, type Ctx } from "@/lib/cli/cli";
import { dashboardCommand, runDashboard } from "./dashboard/cli";
import { authCommand, runAuth } from "./auth/cli";

export const cmd = defineCommand({
  name: "liveone",
  summary: "The LiveOne operator CLI.",
  when:
    "The entry point for operating LiveOne from a terminal or an agent. Pick the domain that owns\n" +
    "the thing you want to read or change — `dashboard` for what a dashboard SHOWS — then the verb.\n" +
    "Run `liveone <domain> --help` to see a domain's verbs.",
  description:
    "Connection and credentials are per-domain; each domain's --help states what it reaches and\n" +
    "what a failure means. Mutating commands change nothing without --apply.",
  subcommands: {
    auth: authCommand,
    dashboard: dashboardCommand,
  },
});

/**
 * Dispatch on the FIRST element of the path — the domain. Each domain then reads the rest for
 * itself, so adding one is a line here plus a module, with no dispatch logic to keep in step.
 */
const DOMAINS: Record<string, (ctx: Ctx) => Promise<number>> = {
  auth: runAuth,
  dashboard: runDashboard,
};

run(
  cmd,
  async (ctx) => {
    const domain = ctx.subcommandPath[0];
    const handler = DOMAINS[domain];
    if (!handler)
      throw failWith(
        EXIT.USAGE,
        `unknown domain "${domain}"`,
        "this domain has no handler",
        `domains: ${Object.keys(DOMAINS).join(", ")}`,
      );
    return handler(ctx);
  },
  import.meta.url,
);
