#!/usr/bin/env node
/**
 * Warm-fold boundary guard.
 *
 * The battery-provenance fold is STATEFUL: its output at any instant depends on every interval since
 * the last reset, so it is only correct over a window that starts at a checkpoint anchor or a full
 * `WARMUP_MS` lead-in. That was a convention applied by hand at each call site, expressed in no type
 * — and a third caller (the EV run pricing) folded over a five-minute-padded window and priced a
 * charge session supplied 100% by a solar-charged battery at the grid tariff. Nothing failed; the
 * numbers were quietly wrong on prod for months.
 *
 * `WarmProvenanceInputs` (lib/battery-provenance/types.ts) makes that unrepresentable: the fold takes
 * only branded inputs, and the brand's `unique symbol` cannot be produced by structural typing. That
 * leaves exactly two ways out, and this script closes both:
 *
 *   1. An explicit `as WarmProvenanceInputs` cast, which forges the brand outright. Legal only in the
 *      module that defines it.
 *   2. `certifyWarmInputs(...)`, the sanctioned escape hatch. It is deliberately unrestricted at the
 *      TYPE level — the trusted writer, the seeded reconcile, the offline harness and test fixtures
 *      all legitimately need it — so the gate is an ALLOW-LIST here instead. Adding a caller means
 *      editing this file, which is a visible, reviewable act rather than an import nobody notices.
 *
 * What is deliberately NOT banned: importing `loadProvenanceInputs` itself. Raw inputs are just
 * loaded rows, and `resolveLoadIntensity` legitimately uses them for the STATELESS half of the
 * attribution (the flow series and the per-interval blend) without folding at all. The hazard was
 * never loading a window — it was folding over one.
 *
 * Mirrors scripts/check-readings-boundary.mjs, and covers what `next lint` cannot see (`scripts/`,
 * `packages/`). Wired as `prebuild` / `prebuild:local`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCAN_DIRS = ["app", "lib", "components", "scripts", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".next-build",
  ".git",
  "dist",
  "build",
  "coverage",
]);
const EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The ONE module allowed to mint the brand by cast. */
const CAST_OWNER = "lib/battery-provenance/types.ts";

/** This guard's own source, which necessarily contains every pattern it looks for. */
const SELF = "scripts/check-warm-fold-boundary.mjs";

/**
 * Every module allowed to call `certifyWarmInputs`. Each is a standing claim that the window is warm
 * by some route the compiler cannot see; adding one means justifying it here.
 *
 *  - `types.ts` defines it.
 *  - `warm-inputs.ts` is the sanctioned loader — it certifies both of its own branches.
 *  - `battery-provenance-pg.ts` is the TRUSTED long-window writer: it applies `WARMUP_MS` itself and
 *    is what WRITES the checkpoints everyone else seeds from, so it cannot call the wrapper without
 *    an import cycle.
 *  - `replay-battery-provenance.ts` is the offline harness, which folds an exact window on purpose
 *    so a config sweep is not pinned by a seed (its early intervals are warm-up — see its note).
 */
const CERTIFY_ALLOWED = [
  /^lib\/battery-provenance\/types\.ts$/,
  /^lib\/battery-provenance\/warm-inputs\.ts$/,
  /^lib\/db\/planetscale\/battery-provenance-pg\.ts$/,
  /^scripts\/replay-battery-provenance\.ts$/,
  /__tests__\//, // fixtures are hand-built to start at an anchor
];

const CAST_RE = /\bas\s+(?:unknown\s+as\s+)?WarmProvenanceInputs\b/;
const CERTIFY_RE = /\bcertifyWarmInputs\s*\(/;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, out);
    } else if (e.isFile() && EXT.test(e.name)) {
      out.push(abs);
    }
  }
}

export function findViolations(root = ROOT, dirs = SCAN_DIRS) {
  const files = [];
  for (const d of dirs) {
    const abs = join(root, d);
    try {
      if (statSync(abs).isDirectory()) walk(abs, files);
    } catch {
      /* a scan dir that doesn't exist is not a violation */
    }
  }

  const violations = [];
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join("/");
    if (rel === SELF) continue;
    let src;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    if (rel !== CAST_OWNER && CAST_RE.test(src)) {
      violations.push({
        file: rel,
        rule: "cast",
        message:
          "forges the WarmProvenanceInputs brand with a cast — call certifyWarmInputs(inputs, why) instead",
      });
    }

    if (CERTIFY_RE.test(src) && !CERTIFY_ALLOWED.some((re) => re.test(rel))) {
      violations.push({
        file: rel,
        rule: "certify",
        message:
          "calls certifyWarmInputs — get inputs from loadWarmProvenanceInputs, or add this file to CERTIFY_ALLOWED with a reason",
      });
    }
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length) {
    console.error("\n✗ warm-fold boundary violated:\n");
    for (const v of violations)
      console.error(`    ${v.file}  —  ${v.message}`);
    console.error(
      "\n  The battery-provenance fold is stateful; a window that does not start at a checkpoint\n" +
        "  anchor or a full WARMUP_MS lead-in seeds the store from the grid and stays wrong.\n" +
        "  See lib/battery-provenance/warm-inputs.ts.\n",
    );
    process.exit(1);
  }
  console.log("✓ warm-fold boundary green.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main();
