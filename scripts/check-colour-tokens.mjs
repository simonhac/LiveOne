#!/usr/bin/env node
/**
 * Colour-token boundary guard (docs/architecture/colour-tokens.md).
 *
 * Every colour on the DASHBOARD is reached for by meaning — `text-ink-muted`, not `text-gray-400`;
 * `bg-surface`, not `bg-[#1C1C1E]`. This fails the build when a raw Tailwind palette class appears
 * in a file the dashboard renders.
 *
 * 🛑 WHY A GATE AND NOT A CODE REVIEW. `text-gray-400` still WORKS — `@theme` adds to the default
 * palette rather than replacing it, which is exactly what let the sweep land file by file. So a
 * reintroduced literal renders perfectly, ships silently, and the vocabulary decays one dialog at
 * a time back to the 728-literal state the sweep started from. The gate is the only thing that
 * makes "done" a stable state rather than a high-water mark.
 *
 * SCOPE is an allow-list of paths, not the whole repo: the admin and device-only screens are
 * deliberately still on literals. Adding a path here is how a future slice ratchets forward —
 * EXEMPTIONS may only ever shrink.
 *
 * Wired as `prebuild` / `prebuild:local` (mirrors scripts/check-route-slugs.mjs) so it gates both
 * `next build` and `build:local`; unit-tested via scripts/__tests__/check-colour-tokens.test.ts.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories and files the dashboard renders. Grows as later slices land; never shrinks. */
export const SCOPE = [
  "components/ui",
  "components/dashboard",
  "components/heatmap",
  "components/battery-provenance",
  "components/area-builder",
  "app/dashboard",
  "lib/tile-style.ts",
  "lib/charts/style.ts",
  "lib/role-chrome.ts",
  "lib/point/unit-typography.ts",
  // The json/location metric renders its own <span>, so this is a render site, not a style module.
  // It reached the dashboard through ChartTooltip, EnergyTable and dashboard/DailyStripes while
  // sitting outside SCOPE — which is what the reachability check below now makes impossible.
  "lib/point/format-value.tsx",
  // The card bodies and dashboard chrome that live at the top of components/.
  ...`AmberCard AmberNow AmberPriceIndicator AmberSmallCard BatteryContentsCard ChartTooltip
      CommandActivityLog ControlNotice DashboardChart DashboardClient DashboardSettingsDialog
      DashboardsMenu DeviceMetricsCard EnergyFlowSankey EnergyTable ErrorPanel FlowsSettingsMenu
      GeneratorControlDialog GrantsPanel GridSignalsCard HeatmapChart HomeEnergyCard HwsSmallCard
      LinesChartCard LinkTooltip LoadProvenanceCard NewDashboardDialog NodeTooltip PeriodSwitcher
      RunsCard ServerErrorModal ShareLinksPanel SiteChartsCard TemporalNavigator TeslaChargeLimits
      TeslaControlDialog TeslaSmallCard Tile AddAreaDialog`
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => `components/${n}.tsx`),
];

/**
 * A Tailwind palette class: `<utility>-<hue>[-<shade>][/<alpha>]`.
 *
 * `white` and `black` carry no shade, every other hue does — spelled out rather than made optional,
 * so `border-line` and `text-ok` (token names that happen to start with a utility prefix) cannot
 * match. Arbitrary colour values (`bg-[#1C1C1E]`, `text-[rgb(...)]`) are caught separately below.
 */
const UTIL =
  "text|bg|border|ring|fill|stroke|divide|placeholder|outline|accent|caret|decoration|shadow|from|to|via";
const HUE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const ALPHA = String.raw`(?:/(?:\[[0-9.]+\]|\d{1,3}))?`;
export const PALETTE_CLASS = new RegExp(
  String.raw`\b(?:${UTIL})-(?:(?:white|black)|(?:${HUE})-\d{2,3})${ALPHA}(?![\w-])`,
  "g",
);

/** A hard-coded colour in an arbitrary-value class — `bg-[#1C1C1E]`, `text-[rgb(40,49,66)]`. */
export const ARBITRARY_COLOUR = new RegExp(
  String.raw`\b(?:${UTIL})-\[(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl|oklch|lab|lch)a?\([^\]]*\))\]`,
  "g",
);

/**
 * Sites that stay literal ON PURPOSE, each with the reason. See "Deliberately left literal" in
 * docs/architecture/colour-tokens.md.
 *
 * 🛑 THIS LIST MAY ONLY SHRINK. Every entry is a question someone still has to answer, not an
 * exemption someone may copy. Adding one means arguing in review that a NEW colour should not have
 * a meaning — which is nearly always the wrong answer.
 *
 * That is enforced, not merely asserted: `scripts/__tests__/check-colour-tokens.test.ts` §
 * "the exemption list" pins the COUNT (lower it, never raise it), re-derives each entry's classes
 * from its file via `--no-exemptions` so a stale entry fails the build, checks each file is
 * actually in SCOPE, and holds the doc's "Deliberately left literal" section in lockstep. For most
 * of this layer's life those four checks did not exist and this comment was the only thing holding
 * the line — which is to say, nothing was.
 */
export const EXEMPTIONS = [
  {
    file: "components/LoadProvenanceCard.tsx",
    classes: ["bg-gray-800/50", "border-gray-700/60", "text-cyan-400"],
    why: "pre-tile-style surface + an EV icon on the pool series' hue; goes when the card moves onto TileSurface",
  },
  {
    file: "components/ui/debug-size-badge.tsx",
    classes: ["bg-red-500"],
    why: "a ?debug-only badge, not a danger state — and now in ONE place rather than copied into AmberSmallCard and TeslaSmallCard",
  },
];

/**
 * Strip `//`, block comments and JSX `{/* … *\/}` so prose about colours is not a finding.
 *
 * 🛑 A block comment is blanked IN PLACE, newlines kept. Collapsing one to a single space shifts
 * every line number after it, which this guard did until 2026-09-21: the `text-gray-400` in
 * `lib/point/format-value.tsx` sits on line 53 and was reported as line 33, because the file's
 * 20-line header comment had been eaten. Wrong enough to send you to the wrong function, and
 * silently — the class name still matched, so nothing looked broken.
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function filesUnder(root, target) {
  const abs = join(root, target);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [target];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${target}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(root, child));
    else if (
      /\.(ts|tsx|css)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    )
      out.push(child);
  }
  return out;
}

/** Every colour literal in one file, minus `allowed`. */
function scanFile(root, file, allowed = new Set()) {
  const out = [];
  const lines = stripComments(readFileSync(join(root, file), "utf8")).split(
    "\n",
  );
  lines.forEach((text, i) => {
    for (const re of [PALETTE_CLASS, ARBITRARY_COLOUR]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (allowed.has(m[0])) continue;
        out.push({ file, line: i + 1, cls: m[0] });
      }
    }
  });
  return out;
}

/**
 * @param {string} root repository root
 * @param {string[]} [scope] paths to scan, relative to `root`; defaults to {@link SCOPE}
 * @param {{ exemptions?: boolean }} [opts] `exemptions: false` reports the exempted classes too.
 *   That mode exists for the guard test, which asserts every {@link EXEMPTIONS} entry still
 *   describes its file exactly — so deleting a literal without deleting its entry fails the build
 *   rather than quietly leaving an exemption that covers nothing.
 * @returns {Array<{ file: string, line: number, cls: string }>} violations
 */
export function findColourLiterals(root, scope = SCOPE, opts = {}) {
  const exempt =
    opts.exemptions === false
      ? new Map()
      : new Map(EXEMPTIONS.map((e) => [e.file, new Set(e.classes)]));
  const out = [];
  for (const target of scope) {
    for (const file of filesUnder(root, target)) {
      // The token block itself is where the palette is allowed to be spelled out.
      if (file === "app/globals.css") continue;
      const allowed = exempt.get(file) ?? new Set();
      out.push(...scanFile(root, file, allowed));
    }
  }
  return out;
}

/**
 * Every module specifier a file pulls in: static `import`, `export … from`, `export * from`, and
 * dynamic `import()` (which is also how `next/dynamic` loads a component).
 *
 * 🛑 Type-only imports are NOT skipped, deliberately. `import type X` is easy to spot but
 * `import { type A, B }` is a value import, so a correct rule is fiddly — and skipping them was
 * measured at 18 files out of 261 with zero difference in findings. An over-broad walk has no false
 * negatives, which is the only direction that matters here. Do not "optimise" this.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/** `@/x` and `./x` → a repo-relative `.ts`/`.tsx` path, or null (bare package, .css, .json, …). */
function resolveSpecifier(root, spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = join(root, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(root, dirname(fromFile), spec);
  else return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return relative(root, p);
  }
  // An exact hit only counts if it is code we could find a class in.
  if (/\.tsx?$/.test(base) && existsSync(base) && statSync(base).isFile())
    return relative(root, base);
  return null;
}

/** A test cannot render to a user, so it is not part of the dashboard's frontier. */
function isTestFile(file) {
  return (
    file.includes("__tests__/") ||
    file.startsWith("e2e/") ||
    /\.(test|spec)\.tsx?$/.test(file)
  );
}

/**
 * Files the scoped set imports, transitively, that are NOT themselves scoped.
 *
 * @param {string} root repository root
 * @param {string[]} [scope] defaults to {@link SCOPE}
 * @returns {string[]} repo-relative paths, sorted
 */
export function reachableFrom(root, scope = SCOPE) {
  const scoped = new Set(scope.flatMap((t) => filesUnder(root, t)));
  const seen = new Set(scoped);
  const queue = [...scoped];
  const external = [];
  while (queue.length) {
    const file = queue.pop();
    let src;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    SPECIFIER.lastIndex = 0;
    for (const m of src.matchAll(SPECIFIER)) {
      // A computed specifier — import(`./${name}`) — is unresolvable and silently skipped. That is
      // a real hole; there are none in SCOPE today.
      const dep = resolveSpecifier(root, m[1], file);
      if (!dep || seen.has(dep) || isTestFile(dep)) continue;
      seen.add(dep);
      queue.push(dep);
      if (!scoped.has(dep)) external.push(dep);
    }
  }
  return external.sort();
}

/**
 * 🛑 The invariant a hand-maintained allow-list cannot hold on its own: **nothing the scoped set
 * imports may carry a colour literal without itself being scoped.**
 *
 * `lib/point/format-value.tsx` is why this exists. It renders its own `<span className="…
 * text-gray-400">`, three scoped files import it, and because it was not itself listed in SCOPE the
 * gate called the dashboard clean for the whole life of the token layer. A literal one import away
 * from the thing you are guarding is still on the screen.
 *
 * This deliberately does NOT replace SCOPE with the closure. 255 of the ~261 files reached are pure
 * server modules (`lib/db`, `lib/kv`, `lib/readings`), and calling those "files the dashboard
 * renders" would turn the guard's own vocabulary into noise; a computed scope would also leave the
 * fixture harness and the "never the admin screens" test with no source text to read. SCOPE growing
 * by hand IS the ratchet — this check's job is to tell you which line to add, not to add it.
 */
export function findUnscopedReachableLiterals(root, scope = SCOPE) {
  return reachableFrom(root, scope).flatMap((f) => scanFile(root, f));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  // `node check-colour-tokens.mjs [--root DIR] [--no-exemptions] [path ...]` — paths override
  // SCOPE. All three exist for scripts/__tests__/check-colour-tokens.test.ts, which drives the real
  // CLI over temp fixtures rather than importing from an .mjs (same reasoning as
  // check-readings-boundary.test.ts).
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root =
    rootFlag === -1 ? join(thisFile, "..", "..") : argv[rootFlag + 1];
  const paths = argv.filter(
    (a, i) => !a.startsWith("--") && i !== rootFlag + 1,
  );
  const exemptions = !argv.includes("--no-exemptions");
  const scope = paths.length ? paths : undefined;
  const bad = findColourLiterals(root, scope, { exemptions });

  // The reachability half runs on the real SCOPE only. Over an explicit path list it would follow
  // a one-file fixture's imports out into the repo and report findings nobody asked about — and
  // `--closure` exists so the guard's own test can still exercise it over a fixture tree.
  const closure =
    paths.length && !argv.includes("--closure")
      ? []
      : findUnscopedReachableLiterals(root, scope);

  if (bad.length === 0 && closure.length === 0) {
    console.log(
      `✓ colour tokens: ${(scope ?? SCOPE).length} scoped paths carry no raw palette class`,
    );
    process.exit(0);
  }
  if (closure.length) {
    console.error(
      `\n✗ ${closure.length} colour ${closure.length === 1 ? "literal" : "literals"} in ${
        new Set(closure.map((c) => c.file)).size
      } file(s) the dashboard REACHES but does not scope.\n`,
    );
    for (const c of closure)
      console.error(`  ${relative(".", c.file)}:${c.line}  ${c.cls}`);
    console.error(
      "\nThese render on the dashboard through an import, so the gate's allow-list cannot see" +
        "\nthem. Tokenise the file and add it to SCOPE (scripts/check-colour-tokens.mjs) —" +
        "\nreachable-and-dirty is exactly how a literal ships past a green gate.\n",
    );
    if (bad.length === 0) process.exit(1);
  }
  console.error(
    `\n✗ ${bad.length} raw colour ${bad.length === 1 ? "class" : "classes"} on the dashboard.\n`,
  );
  for (const b of bad)
    console.error(`  ${relative(".", b.file)}:${b.line}  ${b.cls}`);
  console.error(
    "\nColour on the dashboard is reached for by MEANING, not hue — see" +
      "\ndocs/architecture/colour-tokens.md for the vocabulary and the decision table." +
      "\nIf this colour genuinely has no meaning worth naming, say so in EXEMPTIONS" +
      "\n(scripts/check-colour-tokens.mjs) with the reason — that list may only shrink.\n",
  );
  process.exit(1);
}
