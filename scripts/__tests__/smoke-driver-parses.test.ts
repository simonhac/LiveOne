import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";

/**
 * 🛑 THE `/api/v4` SMOKE DRIVER MUST AT LEAST PARSE, AND NOTHING ELSE IN THE REPO CHECKS THAT.
 *
 * `scripts/utils/v4-surface-smoke.ts` is the only artifact that drives the whole `/api/v4` surface
 * against a real server, a real Clerk session and a real Postgres — it is the proof every Phase 14
 * route PR cites. It is also, uniquely, invisible to all three of the repo's gates:
 *
 *   - `tsc --noEmit` never sees it — `tsconfig.json` has `"exclude": [… "scripts" …]`;
 *   - `next build` never sees it — it is not imported from `app/`;
 *   - `npm test` never saw it — no test imported it (importing it would RUN it: it calls `main()` at
 *     module scope and mutates the shared dev database).
 *
 * So a merge conflict resolved badly inside it is a silent, total loss of the surface's only
 * end-to-end check. That is not hypothetical: it happened TWICE in Phase 14, and the second time went
 * unnoticed for two merges.
 *
 *   `6fcddb80` (stage 12)  parses
 *   `0a9e4226` (stage 11)  BROKEN — the rebase merged the section separator comment and the line below
 *                          it, so `} finally {` ended up INSIDE a `//` comment and `main()`'s `try`
 *                          was left unterminated
 *   `e835bc5f` (stage 10)  BROKEN — and additionally declared `const noMembers` twice in one scope
 *   `b8c690dd` (main)      BROKEN — i.e. the driver could not run at all, on main, for three commits
 *
 * The ledger had already recorded the exact mechanism after the FIRST occurrence ("an additive
 * conflict is not automatically a mechanical one — check the seam, not just the marker count"), and it
 * recurred anyway, because the note was advice and not a gate. This is the gate.
 *
 * WHY esbuild AND NOT `tsc`: esbuild is what actually runs the file (`tsx` is an esbuild wrapper), so
 * "esbuild accepts it" is precisely the question — can the driver run? It also catches both real
 * defects above, where a `ts.transpileModule` parse catches only the first. Un-excluding `scripts/`
 * from `tsconfig.json` would be the thorough fix, but it surfaces ~11 pre-existing errors in eight
 * unrelated scripts and is a repo-wide policy change, not this test's business.
 *
 * This is a PARSE check, deliberately — it does not import or execute the module, because importing it
 * calls `main()`, which mutates the shared `liveone-dev` database.
 */
const DRIVERS = [
  "utils/v4-surface-smoke.ts",
  "area-builder-smoke.ts",
] as const;

describe("dev-only driver scripts parse", () => {
  it.each(DRIVERS)("scripts/%s parses", (rel) => {
    const path = join(__dirname, "..", rel);
    const source = readFileSync(path, "utf8");
    expect(() =>
      transformSync(source, { loader: "ts", sourcefile: path }),
    ).not.toThrow();
  });

  it("fails on the exact shape the stage-11 rebase produced", () => {
    // The negative control: an unterminated `try` because `} finally {` was swallowed by the comment
    // above it. Without this, a transform that silently stopped reporting errors would pass vacuously.
    const broken = `
      async function main() {
        try {
          await go();
        // ============================================  } finally {
          await cleanup();
        }
        console.log("done");
      }
    `;
    expect(() => transformSync(broken, { loader: "ts" })).toThrow();
  });
});
