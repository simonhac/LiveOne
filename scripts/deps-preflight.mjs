#!/usr/bin/env node
/**
 * Does this checkout have installed dependencies? Run before `tsx` in the `liveone` npm scripts.
 *
 * Exists because a HALF-installed `node_modules` fails twice over, and neither failure names the
 * cause. A missing `.bin/` gives `sh: tsx: command not found` from the shell, before node starts at
 * all; a package directory present but missing its `package.json` (an interrupted install) gives a
 * 20-line `MODULE_NOT_FOUND` stack out of the middle of the domain import chain. Both read as "the
 * CLI is broken" rather than "run npm install", and one of them cost a session's opening minutes.
 *
 * Lives in `scripts/` rather than `scripts/ops/` on purpose: `cli-conformance.ts` censuses
 * `scripts/ops` and would report a file with no `defineCommand()` block as UNTIERED.
 *
 * 🛑 Checks the FILESYSTEM, not `require.resolve`. A package may legitimately withhold its
 * `package.json` from its `exports` map (drizzle-orm does), so resolution failure does not mean
 * absence — the first draft of this file rejected a perfectly good install for exactly that reason.
 * "Is the directory there with a manifest in it" is also the literal shape of the damage.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nm = join(root, "node_modules");

// `.bin/tsx` is the one the shell needs before node is even reached; the other two are the packages
// the domain import chain touches first, so between them a partial install is caught wherever it
// was interrupted.
const REQUIRED = [
  [".bin/tsx", join(nm, ".bin", "tsx")],
  ["tsx", join(nm, "tsx", "package.json")],
  ["next", join(nm, "next", "package.json")],
  ["drizzle-orm", join(nm, "drizzle-orm", "package.json")],
];

const missing = REQUIRED.filter(([, path]) => !existsSync(path)).map(
  ([name]) => name,
);

if (missing.length > 0) {
  process.stderr.write(
    `error: dependencies are not installed\n` +
      `  missing from node_modules: ${missing.join(", ")} — the install is absent or partial\n` +
      `  → run \`npm install\` in the repo root, then retry\n`,
  );
  process.exit(2); // EXIT.USAGE — the shared CLI vocabulary in lib/cli/cli.ts
}
