#!/usr/bin/env node
/**
 * Readings-seam boundary guard (config-v4 Phase 3 lint ratchet).
 *
 * Enforces that ONLY `lib/readings/**` + `lib/registry/**` touch the three hot time-series tables
 * `point_readings` / `point_readings_agg_5m` / `point_readings_agg_1d`. Because ~29 modules touch
 * them today, it is a RATCHET: green now against `.readings-boundary-baseline.json`, and the baseline
 * shrinks by one module per migration PR. A NEW violator (not in the baseline) hard-fails; a STALE
 * baseline entry (a migrated/removed file no longer touching the tables) ALSO hard-fails — so the
 * ratchet is monotonic and can only shrink. End state: baseline empty → delete it + the `.eslintrc`
 * override → hard boundary.
 *
 * Catches all three evasion modes ESLint's `no-restricted-imports` misses — dynamic `import()`, raw
 * SQL table strings, and `scripts/`+`packages/` (outside `next lint`'s dirs). Wired as `prebuild` /
 * `prebuild:local` (mirrors scripts/check-route-slugs.mjs) so it gates both `next build` and
 * `build:local`; unit-tested via scripts/__tests__/check-readings-boundary.test.ts.
 *
 * See docs/plans/config-v4-execution-plan.md §3.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The camelCase Drizzle symbols (table consts + their inferred row types) exported by
// lib/db/planetscale/schema.ts. Import detection matches these; raw-SQL detection is separate.
export const HOT_SYMBOLS = new Set([
  "pointReadings",
  "pointReadingsAgg5m",
  "pointReadingsAgg1d",
  "PointReading",
  "NewPointReading",
  "PointReadingAgg5m",
  "NewPointReadingAgg5m",
  "PointReadingAgg1d",
  "NewPointReadingAgg1d",
]);

// Matches exactly the three snake_case hot tables. The negative lookahead rejects a trailing word
// char, so `point_readings_flow_attr_1d` / `point_readings_flow_1d` NEVER match (base "point_readings"
// is followed by "_flow", failing the lookahead) — those are different, out-of-scope tables.
export const HOT_TABLE = /\bpoint_readings(_agg_5m|_agg_1d)?(?![_A-Za-z0-9])/;

const SCAN_EXT = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs", ".sql"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".next-build",
  ".git",
  "__tests__",
]);
const DEFAULT_ROOTS = ["app", "lib", "scripts", "packages"];

// Structurally allowed — legitimately reference the tables; never counted.
function isStructurallyAllowed(rel) {
  return (
    rel === "lib/db/planetscale/schema.ts" || // defines the symbols
    rel === "scripts/check-readings-boundary.mjs" || // this guard (contains the literals)
    rel.startsWith("lib/readings/") || // the seam
    rel.startsWith("lib/registry/") ||
    rel.startsWith("drizzle/") || // migrations (raw SQL DDL)
    rel.startsWith("drizzle-planetscale/")
  );
}

// Files where a snake_case hot-table string is a LABEL/bucketing/prose token, not SQL (verified — the
// admin viewer is a client component that runs no SQL; the two `lib`/`app` files assign the name as a
// bucketing label). Suppresses ONLY raw-SQL detection; symbol-import detection still runs, so a future
// real access is still caught. For a single prose/log LINE in an otherwise-real file (e.g. a log
// message naming the table), use the inline `readings-boundary-allow` pragma instead of whole-file entry.
const LABEL_ALLOW = new Set([
  "app/admin/observations/observations-viewer.tsx",
  "app/api/history/route.ts",
  "lib/history/build-series.ts",
]);

/** Inline escape hatch for a single prose/log line: `… point_readings_agg_5m … // readings-boundary-allow`. */
const PRAGMA = "readings-boundary-allow";

/**
 * Blank out block + line comments so prose mentions of the tables don't false-positive, PRESERVING
 * line count (block comments → spaces + their newlines) so line-aware raw-SQL detection stays aligned
 * with the original source. `://` (URLs) is preserved.
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")) // block comments (incl. JSDoc)
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1); // line comments, but not the // in a URL
}

/** True if a module specifier resolves to lib/db/planetscale/schema (…/schema, ./schema, @/…/schema). */
function isSchemaModule(mod) {
  return /(^|\/)schema$/.test(mod); // excludes schema-internal (ends "internal")
}

function bracesHaveHotSymbol(braces) {
  return braces
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .some((name) => HOT_SYMBOLS.has(name));
}

/**
 * Return the boundary violations in a single file's source. Pure — exported for the fixture test.
 * @returns {string[]} human-readable reasons (empty = clean)
 */
export function fileViolations(rel, src, { labelAllow = LABEL_ALLOW } = {}) {
  const reasons = [];
  const code = stripComments(src);

  // (1) symbol imports — static / aliased / `export … from` / dynamic `import()` destructure.
  const staticRe =
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  const dynamicRe =
    /\{([^}]*)\}\s*=\s*(?:await\s+)?import\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let m;
    while ((m = re.exec(code)) !== null) {
      const [, braces, mod] = m;
      if (isSchemaModule(mod) && bracesHaveHotSymbol(braces)) {
        reasons.push(`imports a hot-table symbol from "${mod}"`);
      }
    }
  }

  // (2) raw-SQL table strings (snake_case), line-aware — unless this file is a known label-only site
  // or the individual line carries the inline `readings-boundary-allow` pragma (checked on the
  // ORIGINAL line, since the pragma is written as a trailing comment that stripComments would blank).
  if (!labelAllow.has(rel)) {
    const codeLines = code.split("\n");
    const srcLines = src.split("\n");
    for (let i = 0; i < codeLines.length; i++) {
      if (HOT_TABLE.test(codeLines[i]) && !(srcLines[i] ?? "").includes(PRAGMA)) {
        reasons.push("references a hot table by raw-SQL name");
        break;
      }
    }
  }

  return reasons;
}

function walk(absRoot, repoRoot, out) {
  let entries;
  try {
    entries = readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(absRoot, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, repoRoot, out);
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot < 0 || !SCAN_EXT.has(e.name.slice(dot))) continue;
      const rel = relative(repoRoot, abs).split(sep).join("/");
      if (isStructurallyAllowed(rel)) continue;
      const reasons = fileViolations(rel, readFileSync(abs, "utf8"));
      if (reasons.length) out.set(rel, reasons);
    }
  }
}

/** Scan `roots` (relative to repoRoot) and return a Map<relPath, reasons[]> of offenders. */
export function findOffenders(repoRoot, roots = DEFAULT_ROOTS) {
  const out = new Map();
  // resolve (not join) so an absolute root (e.g. a test's temp dir) is honored.
  for (const r of roots) walk(resolve(repoRoot, r), repoRoot, out);
  return out;
}

function loadBaseline(baselinePath) {
  if (!baselinePath || !existsSync(baselinePath)) return new Set();
  const j = JSON.parse(readFileSync(baselinePath, "utf8"));
  return new Set([...(j.app_lib ?? []), ...(j.scripts ?? [])]);
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const roots = [];
  let baselinePath = join(process.cwd(), ".readings-boundary-baseline.json");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--baseline") baselinePath = args[++i];
    else if (a.startsWith("--baseline=")) baselinePath = a.slice(11);
    else if (a === "--no-baseline") baselinePath = null;
    else roots.push(a);
  }

  const repoRoot = process.cwd();
  const offenders = findOffenders(repoRoot, roots.length ? roots : DEFAULT_ROOTS);
  const baseline = loadBaseline(baselinePath);

  const isNew = [...offenders.keys()].filter((p) => !baseline.has(p)).sort();
  const stale = [...baseline].filter((p) => !offenders.has(p)).sort();

  if (isNew.length) {
    console.error(
      "\n✗ NEW hot-table access outside the readings seam (point_readings / _agg_5m / _agg_1d):\n",
    );
    for (const p of isNew)
      console.error(`    ${p}  —  ${offenders.get(p).join("; ")}`);
    console.error(
      "\n  Route it through lib/readings/dao.ts (or, only if you own the seam, add it under\n" +
        "  lib/readings/** | lib/registry/**). See config-v4 Phase 3.\n",
    );
    process.exit(1);
  }
  if (stale.length) {
    console.error(
      "\n✗ These files no longer touch the hot tables — remove them from\n" +
        "  .readings-boundary-baseline.json (the ratchet only shrinks):\n",
    );
    for (const p of stale) console.error(`    ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log(
    `✓ readings boundary green — ${baseline.size} module(s) still on the baseline.`,
  );
}
