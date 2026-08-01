import { expect, test } from "@playwright/test";
import { CHART_CASES } from "../app/labs/chart-gallery/cases";
import { heatmapHistoryFixture } from "../app/labs/chart-gallery/fixtures";
import { PointInfo } from "../lib/point/point-info";

/**
 * Pixel baselines for every time-series chart, ahead of the Chart.js → d3 migration
 * (docs/plans/chart-library-consolidation.md).
 *
 * From Stage 5 onward the rule is **zero diff**: the charts are being reimplemented on a different
 * rendering stack, so any pixel change is either a regression or a bug being fixed, and must be
 * explained in the PR. Several cases render a KNOWN DEFECT on purpose (see `cases.ts`); their
 * baselines are expected to churn once — deliberately — in Stage 3.
 *
 * Do not add `retries`. A screenshot diff here is a finding.
 */

/**
 * Console noise that is a property of running off-Vercel, not of the charts. Kept as a narrow
 * allow-list rather than relaxing the assertion: `@vercel/analytics` requests
 * `/_vercel/insights/script.js`, which only exists on a Vercel deployment, so it 404s on localhost
 * for every single page. Anything else must still fail the test.
 */
const IGNORED_CONSOLE = [
  /_vercel\/insights/,
  // The browser's console line for a failed subresource carries no URL ("Failed to load resource:
  // the server responded with a status of 404"), so it cannot be allow-listed by origin and would
  // mask which request failed. Drop it here — the `response` listener below reports the same failures
  // WITH their URLs, so nothing is lost.
  /^Failed to load resource:/,
];

test.describe("chart gallery baselines", () => {
  for (const c of CHART_CASES) {
    test(c.id, async ({ page }) => {
      const consoleErrors: string[] = [];
      const note = (text: string) => {
        if (!IGNORED_CONSOLE.some((re) => re.test(text)))
          consoleErrors.push(text);
      };
      page.on("console", (m) => {
        if (m.type() === "error") note(m.text());
      });
      page.on("pageerror", (e) => note(String(e)));
      // The console message for a failed subresource omits the URL, so match on the request instead.
      page.on("response", (r) => {
        if (r.status() >= 400) note(`${r.status()} ${r.url()}`);
      });

      // The heatmap is the one chart that fetches for itself, so its data arrives by interception
      // rather than as props. Everything rendered derives from this payload, so the baseline is just
      // as deterministic as the prop-driven ones — the component's own request window (which does
      // come from the real clock) only affects the URL, which is matched by pattern.
      if (c.kind === "heatmap") {
        const body = heatmapHistoryFixture({
          pointPath: c.pointPath,
          seriesSuffix: PointInfo.getPreferredAggregationForMetricType(
            c.metricType,
          ),
          units: c.pointUnit,
          endDayIso: c.endDay,
          offsetMin: c.dayOffsetMin,
          narrowBandAround: c.narrowBandAround,
        });
        await page.route("**/api/history**", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          }),
        );
      }

      await page.goto(`/labs/chart-gallery?case=${c.id}`);

      const frame = page.getByTestId("chart-case");
      await expect(frame).toHaveAttribute("data-case-id", c.id);

      // The gallery holds the chart unmounted until webfonts are ready, because Chart.js measures
      // tick widths at first layout and never re-measures (see `useFontsReady`). Waiting on the flag
      // it sets is therefore both the font wait AND the mount wait.
      await expect(frame).toHaveAttribute("data-case-ready", "true");
      // Wait for a drawing surface with a real size — canvas OR svg. Both matter: Chart.js paints
      // into a canvas, the ported charts render SVG, and during Stage 5 the suite covers a mix of
      // the two. Checking only for a canvas would fail every SVG chart with a misleading timeout.
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const frame = document.querySelector(
                '[data-testid="chart-case"]',
              );
              const surfaces = frame?.querySelectorAll("canvas, svg") ?? [];
              for (const el of Array.from(surfaces)) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
              }
              return false;
            }),
          {
            message: "no canvas or svg in the case frame ever acquired a size",
          },
        )
        .toBe(true);
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );

      await expect(frame).toHaveScreenshot(`${c.id}.png`);

      // A chart that renders correctly but throws is still broken, and the port is exactly the kind
      // of change that introduces a silent runtime error in a hover path.
      expect(consoleErrors, `console errors on ${c.id}`).toEqual([]);
    });
  }
});

test("the gallery index lists every case", async ({ page }) => {
  // Guards the harness itself: if a case is added to `cases.ts` but the gallery cannot render it,
  // the per-case tests above would fail one-by-one with a confusing "unknown case" body. This fails
  // once, clearly.
  await page.goto("/labs/chart-gallery");
  await expect(
    page.getByRole("heading", { name: "Chart gallery" }),
  ).toBeVisible();
  for (const c of CHART_CASES) {
    await expect(
      page.getByRole("link", { name: c.id, exact: true }),
    ).toBeVisible();
  }
});
