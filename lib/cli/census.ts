/**
 * The CLI census — the checks behind `scripts/ops/cli-conformance.ts`.
 *
 * Lives in `lib/` rather than beside the tool because the tool calls `run(…, import.meta.url)` at
 * module load, and a file containing `import.meta` cannot be imported by jest (ts-jest compiles the
 * suite to CommonJS). Keeping the logic here is what makes it directly testable — and thin
 * entrypoints are the shape the rest of the kit already assumes.
 *
 * TWO DIRECTIONS, and the second is the one that matters:
 *
 *   1. Every file the manifest LISTS must exist, and a tier-A/B tool must be on the shared harness.
 *   2. Every first-party CLI-shaped file the manifest does NOT list is reported as UNTIERED.
 *
 * (2) is the whole point. For a year nanti's checker built its target list *from* the manifest, so
 * an unlisted file was not walked at all — not linted, not documented, not covered by any rule —
 * and its `check:cli` stayed green while eight CLIs went through hand-rolling `process.argv`, two
 * of them named by flag in its own CLAUDE.md. Unlisted is a finding, never an exemption.
 */
import fs from "node:fs";
import path from "node:path";
import { loadTiers, type TierManifest } from "./tiers";

/**
 * 🛑 SCOPE, DELIBERATELY NARROW FOR NOW. The census walks `scripts/ops` only — the home of
 * converted operator CLIs. The rest of `scripts/` holds ~100 pre-harness one-offs, and gating on a
 * backlog that size is how a check gets switched off rather than fixed (nanti's own note: "it gates
 * once the conversion is done"). Widening this is the next step, and it will surface that backlog
 * as findings rather than silence.
 */
export const CENSUS_ROOTS = ["scripts/ops"];

const IGNORE = /(\.test\.ts|\.itest\.ts|\.d\.ts)$/;

/** A file that looks like a CLI: it has an entrypoint guard, or it reads argv itself. */
const CLI_SHAPED = ["import.meta.url", "process.argv"];

export type FindingCode =
  | "MISSING"
  | "NOT_CONVERTED"
  | "NO_ENTRYPOINT_GUARD"
  | "UNTIERED";

export interface Finding {
  code: FindingCode;
  file: string;
  detail: string;
}

/** The filesystem the census reads — injectable so tests need no fixtures on disk. */
export interface CensusFs {
  exists(p: string): boolean;
  read(p: string): string;
  /** Every `.ts` file under `dir`, recursively, repo-relative. */
  list(dir: string): string[];
}

export function nodeFs(repo: string = process.cwd()): CensusFs {
  const walk = (dir: string, out: string[] = []): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(repo, dir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel, out);
      else if (e.name.endsWith(".ts") && !IGNORE.test(e.name)) out.push(rel);
    }
    return out;
  };
  return {
    exists: (p) => fs.existsSync(path.join(repo, p)),
    read: (p) => fs.readFileSync(path.join(repo, p), "utf8"),
    list: (dir) => walk(dir),
  };
}

export function census(
  io: CensusFs = nodeFs(),
  manifest?: TierManifest,
  roots: readonly string[] = CENSUS_ROOTS,
): Finding[] {
  const tiers = loadTiers(manifest);
  const findings: Finding[] = [];

  // Direction 1: what the manifest claims.
  for (const file of tiers.all()) {
    if (!io.exists(file)) {
      findings.push({
        code: "MISSING",
        file,
        detail:
          "listed in the manifest but not on disk — delete the entry or restore the file",
      });
      continue;
    }
    const tier = tiers.tierOf.get(file)!;
    if (tier !== "a" && tier !== "b") continue;
    const src = io.read(file);
    if (!src.includes("defineCommand(") || !src.includes("export const cmd"))
      findings.push({
        code: "NOT_CONVERTED",
        file,
        detail: `tier ${tier} but not on the shared harness — it must \`export const cmd = defineCommand({…})\``,
      });
    else if (!src.includes("import.meta.url"))
      findings.push({
        code: "NO_ENTRYPOINT_GUARD",
        file,
        detail:
          "run() without import.meta.url executes at module load, so importing this tool RUNS it",
      });
  }

  // Direction 2: what the manifest omits.
  for (const root of roots)
    for (const file of io.list(root)) {
      if (tiers.tierOf.has(file)) continue;
      const src = io.read(file);
      if (!CLI_SHAPED.some((m) => src.includes(m))) continue;
      findings.push({
        code: "UNTIERED",
        file,
        detail:
          "CLI-shaped but absent from lib/cli/tiers.ts — unlisted means unchecked and undocumented",
      });
    }

  return findings.sort((a, b) =>
    a.file === b.file ? a.code.localeCompare(b.code) : a.file < b.file ? -1 : 1,
  );
}
