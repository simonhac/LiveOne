import { describe, it, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Guards against the Next.js App Router dynamic-slug collision that took prod
 * down on 2026-06-15 (PR #98: `app/api/systems/[id]/` next to
 * `app/api/systems/[systemId]/`). Runs the real `prebuild` gate as a subprocess
 * and asserts a clean exit over the live `app/` tree.
 *
 * See scripts/check-route-slugs.mjs.
 */
describe("route-slug collisions", () => {
  const repoRoot = join(__dirname, "..", "..");
  const script = join(repoRoot, "scripts", "check-route-slugs.mjs");

  it("has no sibling dynamic-slug collisions under app/", () => {
    try {
      execFileSync("node", [script], { cwd: repoRoot, stdio: "pipe" });
    } catch (err: any) {
      // Surface the scanner's stderr (the offending paths) in the test failure.
      throw new Error(
        `Route-slug collision detected:\n${err.stderr?.toString() ?? err.message}`,
      );
    }
  });
});
