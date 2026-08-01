import { defineConfig, devices } from "@playwright/test";

/**
 * Screenshot-baseline harness for the Chart.js → d3 migration
 * (docs/plans/chart-library-consolidation.md). Targets `/labs/chart-gallery`, which renders every
 * chart from deterministic fixtures — no network, no clocks, no auth.
 *
 * Determinism is the whole point, so several settings are load-bearing rather than boilerplate:
 *
 *  - `timezoneId` — the charts format ticks with date-fns `format`, which renders in the BROWSER's
 *    local zone. Unpinned, the same fixture produces different axis labels on a laptop in Melbourne
 *    and in CI on UTC.
 *  - `locale` — `toLocaleString`-driven number/date output varies by locale.
 *  - `deviceScaleFactor: 1` — a retina Mac would otherwise write 2× baselines that CI can't match.
 *  - `animations: "disabled"` + `caret: "hide"` on every screenshot.
 *  - `workers: 1` — parallel Next dev compilation makes the first paint of each route flaky.
 *
 * Runs against a PRODUCTION build (`next start`), not `next dev`: dev-mode injects an indicator, and
 * recompiles on first hit, which shows up as timing flake. `BUILD_DIR=.next-e2e` keeps it clear of
 * both the dev server's `.next` and `build:local`'s `.next-build`.
 */
const PORT = Number(process.env.E2E_PORT ?? 3399);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // A baseline diff is a finding, not a flake — never paper over one with a retry.
  retries: 0,
  workers: 1,
  fullyParallel: false,
  // Refuse to silently pass when someone leaves a .only in.
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  outputDir: ".playwright/results",

  expect: {
    toHaveScreenshot: {
      // These two do different jobs, and getting the split wrong makes the suite quietly useless:
      //
      //  - `threshold` is the PER-PIXEL colour tolerance (YIQ, 0–1). This is what absorbs
      //    antialiasing differences on text and curves, so it carries the flake tolerance.
      //  - `maxDiffPixelRatio` is HOW MANY pixels may differ. Because antialiasing is already
      //    absorbed above, this should be small. The initial 0.002 was not: on a 932×372 frame it
      //    permitted ~700 differing pixels — more than a thin chart line even contains, so a
      //    whole-line colour change could pass. Measured sensitivity is recorded in the plan doc.
      threshold: 0.15,
      maxDiffPixelRatio: 0.0002,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  use: {
    baseURL: BASE_URL,
    timezoneId: "Australia/Melbourne",
    locale: "en-AU",
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "off",
    video: "off",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], deviceScaleFactor: 1 },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        deviceScaleFactor: 1,
        // Pixel 7's default is a 3× DPR touch device; keep the touch/mobile branches
        // (`"ontouchstart" in window`) exercised but the raster 1:1.
        isMobile: true,
        hasTouch: true,
      },
    },
  ],

  webServer: {
    command: `BUILD_DIR=.next-e2e npx next build && BUILD_DIR=.next-e2e npx next start --port ${PORT}`,
    // Probe the GALLERY, not `/`. The root route is Clerk-gated and answers the readiness check with
    // a redirect/404, so Playwright would decide the server isn't up, ignore `reuseExistingServer`,
    // and then fail to bind the port an already-running server holds.
    url: `${BASE_URL}/labs/chart-gallery`,
    // A cold `next build` is slow; don't let Playwright's default 60s kill it.
    timeout: 15 * 60 * 1000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      TZ: "Australia/Melbourne",
      // Belt and braces: the gallery must never be reachable in a prod build, and we are not one.
      VERCEL_ENV: "",
    },
  },
});
