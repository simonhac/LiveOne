#!/usr/bin/env tsx
/**
 * cli-conformance — the census and shape checks for LiveOne's operator CLIs.
 *
 * A thin entrypoint: the checks themselves live in `lib/cli/census.ts`, where jest can import them
 * (a file containing `import.meta` cannot be). Read that module for what each finding means and
 * why the census walks in both directions.
 */
import { defineCommand, run, EXIT, type Ctx } from "@/lib/cli/cli";
import { census, type Finding } from "@/lib/cli/census";
import { loadTiers, type Tier } from "@/lib/cli/tiers";

export const cmd = defineCommand({
  name: "cli-conformance",
  summary:
    "Check that every operator CLI is registered and on the shared harness.",
  when:
    "Run this after adding a CLI, or when `npm run check:cli` fails. It answers two questions the\n" +
    "generated reference cannot: is anything claimed that does not exist, and is anything present\n" +
    "that was never declared.",
  description:
    "Reports MISSING (the manifest names a file that is gone), NOT_CONVERTED and\n" +
    "NO_ENTRYPOINT_GUARD (a tier A/B tool that is not on the harness) and UNTIERED (a CLI-shaped\n" +
    "file the manifest omits). The census currently walks scripts/ops only — see the 🛑 note in\n" +
    "lib/cli/census.ts before widening it.",
  flags: {
    tier: {
      type: "string",
      values: ["a", "b", "c", "lib"],
      help: "Only report findings for files in this tier",
    },
  },
  exitCodes: { 1: "at least one finding" },
  examples: ["npm run check:cli", "npm run check:cli -- --tier a"],
});

async function main(ctx: Ctx): Promise<number> {
  const tiers = loadTiers();
  const only = ctx.flags.tier as Tier | undefined;
  const findings = census().filter(
    (f) => !only || tiers.tierOf.get(f.file) === only,
  );

  ctx.emit({ count: findings.length, findings }, (m: never) => {
    const model = m as { count: number; findings: Finding[] };
    if (!model.count)
      return `No findings${only ? ` in tier ${only}` : ""} — every CLI is registered and converted.`;
    return [
      ...model.findings.map(
        (f) => `  ${f.code.padEnd(20)} ${f.file}\n${" ".repeat(23)}${f.detail}`,
      ),
      "",
      `${model.count} finding(s).`,
    ].join("\n");
  });

  return findings.length ? EXIT.FINDINGS : EXIT.OK;
}

run(cmd, main, import.meta.url);
