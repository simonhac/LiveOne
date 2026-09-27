import { test, expect, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SECTIONS } from "../app/labs/card-gallery/sections";
import { CHART_COLORS } from "../lib/chart-colors";
import { ROLE_CHROME } from "../lib/role-chrome";
import { getPriceLevelGradient, type PriceLevel } from "../lib/amber-utils";
import {
  censusSection,
  expectedPalette,
  mergeCensus,
  keySet,
  unknownColours,
  toBaseline,
  type Census,
} from "./census";

/**
 * The computed-colour census over `/labs/card-gallery`, as a standing test.
 *
 * It was run ONCE by hand for PR #554 to prove that sweep was a pure rename, and no script
 * survived — so the claim decayed back into an argument the next day. Two assertions, which answer
 * different questions and are both needed:
 *
 *   A. EVERY COLOUR IS A KNOWN VALUE — a token from `app/globals.css`, or a listed literal. This is
 *      the invariant the architecture doc actually claims, it is immune to element-count drift, and
 *      it catches a NEWLY ADDED card shipping `text-gray-400` (which the `prebuild` gate only sees
 *      if that file is in its SCOPE). It does NOT catch a re-tone from one legal token to another.
 *   B. THE SET OF (property, colour) PAIRS EQUALS THE COMMITTED BASELINE. This is what makes "my
 *      change is a pure rename" evidence. It cannot tell "changed" from "changed correctly", which
 *      is why A exists.
 *
 * 🛑 COUNTS ARE RECORDED BUT NOT ASSERTED. The count of elements bearing a colour is the part
 * sensitive to render races; the SET of colours is not (a missing generator row does not remove a
 * colour ten other elements also carry). Keeping the counts in the artefact makes a real change
 * visible in the git diff when a human regenerates, without making the suite flaky.
 * `elementCount` IS asserted, as a tripwire: if it moves, the determinism gate is broken and that
 * is a thing to go and look at, not a tolerance to widen.
 *
 * 🛑 PLATFORM-INDEPENDENT, unlike `charts.spec.ts`. A normalised sRGB quad has no font rasteriser
 * and no subpixel antialiasing in it, so these baselines are not suffixed `-darwin` and a Linux
 * runner can check baselines generated on a Mac. That is what makes this the CI candidate of the
 * two — see docs/architecture/colour-tokens.md.
 *
 * KNOWN BLIND SPOTS, stated because a census that quietly misses things is worse than none:
 *  - `DeviceMetricsCard` has no gallery section, so nothing here sees it.
 *  - The resizable playground is deliberately NOT censused (no `data-card-case`): its size is
 *    user-driven state behind a ResizeObserver, and the preset widths already cover the matrix
 *    deterministically.
 *  - An inline `style={{ color: ... }}` IS seen here (it is a computed style like any other), even
 *    though the `prebuild` gate cannot see it. This is the only check that covers those.
 */

const BASELINE_DIR = path.join(__dirname, "cards.spec.ts-census");
const UPDATE = !!process.env.UPDATE_CENSUS;

/** A fixed instant, so the fixtures' module-scope `Date.now()` stamps are reproducible. */
const FIXED_NOW = new Date("2026-03-16T10:30:00+11:00");

/** Every price level the Amber cards can paint — the gradient palette is derived from these. */
const PRICE_LEVELS: PriceLevel[] = [
  "extremelyLow",
  "veryLow",
  "low",
  "neutral",
  "high",
  "spike",
  "missing",
];

/**
 * Every `--color-*` token name in the `@theme` block.
 *
 * Names only — the VALUES are resolved by the browser (see `expectedPalette`), because
 * re-implementing oklch -> sRGB in Node would be a second implementation of the one conversion this
 * whole layer exists to get right. Same regex as `lib/__tests__/colour-tokens.test.ts`.
 */
function tokenNames(): string[] {
  const css = readFileSync(
    path.join(__dirname, "..", "app", "globals.css"),
    "utf8",
  );
  return [...css.matchAll(/^\s*(--color-[a-z0-9-]+):/gm)].map((m) => m[1]);
}

/**
 * Colours that are legitimately NOT tokens, each with a reason.
 *
 * An SVG stroke, a canvas fill and a gradient stop cannot be utility classes, so these live in
 * TypeScript by necessity — `lib/chart-colors.ts` is the authority and the `series-*` tokens are
 * defined FROM it. Anything not here and not a token is a finding.
 */
function allowedLiterals(): string[] {
  const flat = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : v && typeof v === "object"
        ? Object.values(v as object).flatMap(flat)
        : [];
  return [
    // The chart palette, in full — series traces, focus line, the lot.
    ...flat(CHART_COLORS),
    // Each role's `rgb`, which its SVG ring is drawn in.
    ...Object.values(ROLE_CHROME).map((r) => r.rgb),
    // Brand inks that ride on a brand fill, so they cannot take the page's ramp.
    "rgb(0, 11, 36)", // Amber's logo navy, on the price disc
    "rgb(0, 0, 0)", // black text on Amber's gradient disc
    "rgb(255, 255, 255)", // white, incl. SVG marks
    // Ring tips: a lighter shade at the end of a fat ring (TeslaSmallCard, GridSignalsCard).
    "rgb(248, 113, 113)", // EV_LIGHT_RGB, red-400
    "rgb(134, 239, 172)", // RENEWABLES_LIGHT_RGB, green-300
    // 🛑 Amber's price-level gradients, READ FROM THE FUNCTION THAT EMITS THEM rather than
    // hand-copied. These are the colours the prebuild gate structurally cannot see — a
    // `radial-gradient` lands in `backgroundImage`, and both of that gate's checks match CLASSES —
    // and this census found all five on its first real run. They are Amber-the-retailer's own
    // price palette (the same identity argument as `brand-amber`, which is deliberately NOT `warn`),
    // and a gradient cannot be a utility class, so they stay literal in `lib/amber-utils.ts`.
    ...PRICE_LEVELS.flatMap((lvl) =>
      [...getPriceLevelGradient(lvl).matchAll(/rgba?\([^)]*\)/g)].map(
        (m) => m[0],
      ),
    ),
    // The gate's one remaining EXEMPTION, resolved through the shipped CSS as a class.
    "bg-red-500",
  ];
}

/** Walk one section across every scenario (plus a stale pass) and union the result. */
async function censusAllScenarios(
  page: Page,
  slug: string,
  scenarios: string[],
): Promise<Census> {
  let acc: Census | null = null;
  const passes = [
    ...scenarios.map((s) => ({ scenario: s, stale: false })),
    // One stale pass on the default: the stale ink ramp and badge are their own colours, and
    // crossing stale with every scenario would multiply the walk for no new palette.
    { scenario: scenarios[0], stale: true },
  ];
  for (const p of passes) {
    const q = new URLSearchParams({ section: slug, scenario: p.scenario });
    if (p.stale) q.set("stale", "1");
    await page.goto(`/labs/card-gallery?${q}`);
    await expect(page.locator('[data-gallery-ready="true"]')).toBeAttached({
      timeout: 30_000,
    });
    await expect(page.locator("[data-card-case]").first()).toBeAttached();
    const c = await censusSection(page, slug);
    acc = acc ? mergeCensus(acc, c) : c;
  }
  return acc!;
}

test.describe("card gallery — colour census", () => {
  test.beforeEach(async ({ page }) => {
    // `setFixedTime`, not `install`: setTimeout/setInterval must still run, because the gallery's
    // fetch stub answers on a timer and React Query needs its own scheduling.
    await page.clock.setFixedTime(FIXED_NOW);
  });

  for (const section of SECTIONS) {
    const scenarios = [...section.scenarios];

    test(`${section.slug} — every colour is a token or a listed literal`, async ({
      page,
    }) => {
      const consoleErrors: string[] = [];
      page.on("pageerror", (e) => consoleErrors.push(String(e)));

      const census = await censusAllScenarios(page, section.slug, scenarios);
      const allowed = await expectedPalette(
        page,
        tokenNames(),
        allowedLiterals(),
      );
      const unknown = unknownColours(census, allowed);
      expect(
        unknown,
        `Colours in "${section.slug}" that are neither a --color-* token nor a listed literal.\n` +
          `Each is either a raw palette class that slipped past the prebuild gate, or a\n` +
          `legitimate non-token colour that belongs in allowedLiterals() with a reason.\n` +
          JSON.stringify(unknown, null, 2),
      ).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });

    test(`${section.slug} — census matches the baseline`, async ({
      page,
      isMobile,
    }) => {
      // Desktop only: mobile renders a different element population (the Tile and Local Grid cards
      // switch layout at 768px), so a shared baseline would be wrong and two baselines would double
      // the regeneration burden for little extra signal. Assertion A still runs on both.
      test.skip(!!isMobile, "the census baseline is pinned on desktop");

      const census = await censusAllScenarios(page, section.slug, scenarios);
      const file = path.join(BASELINE_DIR, `${section.slug}.json`);

      if (UPDATE) {
        mkdirSync(BASELINE_DIR, { recursive: true });
        writeFileSync(file, JSON.stringify(toBaseline(census), null, 2) + "\n");
        test
          .info()
          .annotations.push({ type: "census", description: "written" });
        return;
      }

      expect(
        existsSync(file),
        `No baseline for "${section.slug}". Generate with:\n` +
          `  npm run test:e2e:census:update`,
      ).toBe(true);
      const baseline = JSON.parse(readFileSync(file, "utf8")) as ReturnType<
        typeof toBaseline
      >;

      expect(keySet(census)).toEqual(
        keySet({ ...census, colours: baseline.colours }),
      );
      // Tripwire, not a finding — see the header.
      expect(
        census.elementCount,
        "element count moved: the gallery's readiness gate is no longer deterministic",
      ).toBe(baseline.elementCount);
    });
  }

  test("the census covers every section the gallery renders", async ({
    page,
  }) => {
    // The analogue of charts.spec.ts's index guard: a section added to the page but not to
    // SECTIONS would simply never be censused, and nothing else would say so.
    await page.goto("/labs/card-gallery");
    await expect(page.locator('[data-gallery-ready="true"]')).toBeAttached({
      timeout: 30_000,
    });
    const rendered = await page
      .locator("[data-section]")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-section")).sort(),
      );
    expect(rendered).toEqual(SECTIONS.map((s) => s.slug).sort());
  });
});
