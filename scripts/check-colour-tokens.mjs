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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
 */
export const EXEMPTIONS = [
  {
    file: "components/LoadProvenanceCard.tsx",
    classes: ["bg-gray-800/50", "border-gray-700/60", "text-cyan-400"],
    why: "pre-tile-style surface + an EV icon on the pool series' hue; goes when the card moves onto TileSurface",
  },
  {
    file: "components/DeviceMetricsCard.tsx",
    classes: ["bg-gray-800/40"],
    why: "same pre-tile-style surface family",
  },
  {
    file: "components/AmberNow.tsx",
    classes: ["bg-slate-200"],
    why: "the one light-on-dark surface in the app",
  },
  {
    file: "components/AmberSmallCard.tsx",
    classes: ["bg-red-500"],
    why: "a ?debug-only badge, not a danger state",
  },
  {
    file: "components/TeslaSmallCard.tsx",
    classes: ["bg-red-500"],
    why: "a ?debug-only badge, not a danger state",
  },
];

/** Strip `//`, block comments and JSX `{/* … *\/}` so prose about colours is not a finding. */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
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

/**
 * @param {string} root repository root
 * @param {string[]} [scope] paths to scan, relative to `root`; defaults to {@link SCOPE}
 * @returns {Array<{ file: string, line: number, cls: string }>} violations
 */
export function findColourLiterals(root, scope = SCOPE) {
  const exempt = new Map(EXEMPTIONS.map((e) => [e.file, new Set(e.classes)]));
  const out = [];
  for (const target of scope) {
    for (const file of filesUnder(root, target)) {
      // The token block itself is where the palette is allowed to be spelled out.
      if (file === "app/globals.css") continue;
      const allowed = exempt.get(file) ?? new Set();
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
    }
  }
  return out;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  // `node check-colour-tokens.mjs [--root DIR] [path ...]` — paths override SCOPE. Both exist for
  // scripts/__tests__/check-colour-tokens.test.ts, which drives the real CLI over temp fixtures
  // rather than importing from an .mjs (same reasoning as check-readings-boundary.test.ts).
  const argv = process.argv.slice(2);
  const rootFlag = argv.indexOf("--root");
  const root =
    rootFlag === -1 ? join(thisFile, "..", "..") : argv[rootFlag + 1];
  const paths = argv.filter(
    (a, i) => !a.startsWith("--") && i !== rootFlag + 1,
  );
  const bad = findColourLiterals(root, paths.length ? paths : undefined);
  if (bad.length === 0) {
    console.log(
      `✓ colour tokens: ${(paths.length ? paths : SCOPE).length} scoped paths carry no raw palette class`,
    );
    process.exit(0);
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
