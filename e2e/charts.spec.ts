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

test.describe("run bands on touch", () => {
  // Touch has no hover, so a run band is TAPPED open and tapped shut. Desktop is left alone — this
  // whole describe is skipped there, since a synthetic tap on a hover-bound band proves nothing.
  test.skip(
    ({ hasTouch }) => !hasTouch,
    "tap-to-toggle only exists on a touch device",
  );

  /**
   * The striped fill path is what the hovered state swaps the pattern on. `> path` (a DIRECT child)
   * rather than a descendant: the group opens with a `<defs>` holding two `<clipPath>`s, whose own
   * `<path d=…>` carries no `fill` at all and would otherwise match first.
   */
  const fill = (page: import("@playwright/test").Page) =>
    page.locator("[data-run] > path").first();

  /**
   * Tap a point that is actually ON the run.
   *
   * `locator.tap()` aims at the element's bounding-box CENTRE, and for a run group that centre is
   * usually bare chart: `getBoundingClientRect` ignores `clip-path`, so the group reports the whole
   * band's width and height even though the run is a narrow slice of it, clipped twice. Playwright
   * then correctly refuses, reporting that the `<svg>` intercepts the tap.
   *
   * So: take the x from the run's own clipping rect (whose `x`/`width` ARE the run's range) and hunt
   * down the column for the first y that actually hit-tests to the run.
   */
  const tapRun = async (page: import("@playwright/test").Page) => {
    const point = await page.evaluate(() => {
      const g = document.querySelector("[data-run]");
      const rect = g?.querySelector(":scope > rect");
      if (!rect) return null;
      const r = rect.getBoundingClientRect();
      const x = r.left + r.width / 2;
      for (let y = r.top + 1; y < r.bottom; y += 2) {
        if (document.elementFromPoint(x, y)?.closest("[data-run]"))
          return { x, y };
      }
      return null;
    });
    expect(point, "no point inside the run hit-tested to it").not.toBeNull();
    await page.touchscreen.tap(point!.x, point!.y);
  };

  test("tapping a run opens it and tapping it again closes it", async ({
    page,
  }) => {
    await page.goto("/labs/chart-gallery?case=stacked-load-d-runs");
    const frame = page.getByTestId("chart-case");
    await expect(frame).toHaveAttribute("data-case-ready", "true");
    await expect(page.locator("[data-run]").first()).toBeVisible();

    // Assert on the ink rather than a screenshot: the hovered/unhovered pair is already baselined by
    // the `stacked-load-d-runs` / `-hovered` cases, and what is under test here is the toggle.
    await expect(fill(page)).toHaveAttribute("fill", /-stripe\)$/);

    await tapRun(page);
    await expect(fill(page)).toHaveAttribute("fill", /-stripe-hover\)$/);

    await tapRun(page);
    await expect(fill(page)).toHaveAttribute("fill", /-stripe\)$/);

    // Outside-tap dismissal is deliberately NOT asserted here: it lives in `SiteChartsCard`'s
    // `StackedChart`, which owns the panel, and the gallery mounts `DashboardChart` alone. Manual
    // check only, until something mounts the card outside the Clerk gate.
  });
});

test.describe("axis-tap navigation on touch", () => {
  // The zones only exist on a touch device (`DashboardChart` gates them on `isTouch`), so on
  // desktop there is nothing here to tap and a synthetic tap would prove nothing.
  test.skip(({ hasTouch }) => !hasTouch, "the axis-tap zones are touch-only");

  /**
   * Geometry of the axis strip, in viewport coordinates.
   *
   * `top` comes from a time-axis GRIDLINE, whose `y2` is the plot height by construction
   * (`TimeAxis`) — so the strip begins exactly where the plot ends, without this test carrying its
   * own copy of `DEFAULT_MARGIN`. `left`/`right` come from the same gridlines' extent, which is the
   * plot's width, i.e. the span the handler halves.
   */
  const strip = async (page: import("@playwright/test").Page) => {
    const box = await page.evaluate(() => {
      const lines = Array.from(
        document.querySelectorAll('[data-testid="time-axis"] line'),
      );
      if (lines.length === 0) return null;
      const rects = lines.map((l) => l.getBoundingClientRect());
      return {
        top: Math.max(...rects.map((r) => r.bottom)),
        left: Math.min(...rects.map((r) => r.left)),
        right: Math.max(...rects.map((r) => r.right)),
      };
    });
    expect(
      box,
      "no time-axis gridlines to measure the strip from",
    ).not.toBeNull();
    return box!;
  };

  /** Opens a case and hands back the element the gallery reports axis taps on. */
  const open = async (page: import("@playwright/test").Page, id: string) => {
    await page.goto(`/labs/chart-gallery?case=${id}`);
    await expect(page.getByTestId("chart-case")).toHaveAttribute(
      "data-case-ready",
      "true",
    );
    await expect(page.getByTestId("axis-tap-hints")).toBeVisible();
    const report = page.getByTestId("axis-tap-report");
    await expect(report).toHaveAttribute("data-axis-tap", "none");
    return report;
  };

  test("tapping the two halves of the axis strip steps older and newer", async ({
    page,
  }) => {
    const frame = await open(page, "stacked-load-d-axis-tap");
    const s = await strip(page);
    const mid = (s.left + s.right) / 2;

    // 🛑 +3px: the TOP of the strip, immediately under the plot. The zone is the whole 48px, and a
    // test that only ever tapped the middle would still pass if the live area had collapsed to the
    // glyph's own line.
    await page.touchscreen.tap((s.left + mid) / 2, s.top + 3);
    await expect(frame).toHaveAttribute("data-axis-tap", "older");

    // …and +40px is near the BOTTOM of it, which is what pins the strip at the 44px touch minimum:
    // at the old 34px margin this point is outside the svg entirely.
    await page.touchscreen.tap((mid + s.right) / 2, s.top + 40);
    await expect(frame).toHaveAttribute("data-axis-tap", "newer");
  });

  test("an axis tap does not move the crosshair", async ({ page }) => {
    // The reason the handler returns before `pointer.onPointerDown`: stepping the window must not
    // also drag the shared focus (and with it the energy table and the Sankey) to wherever the
    // finger happened to land on the way.
    const frame = await open(page, "stacked-load-d-axis-tap");
    const s = await strip(page);

    await expect(page.getByTestId("focus-line")).toHaveCount(0);
    await page.touchscreen.tap((s.left + s.right) / 4, s.top + 20);
    await expect(frame).toHaveAttribute("data-axis-tap", "older");
    await expect(page.getByTestId("focus-line")).toHaveCount(0);

    // A tap in the PLOT still focuses, so the guard is narrow rather than a dead chart.
    await page.touchscreen.tap((s.left + s.right) / 2, s.top - 20);
    await expect(page.getByTestId("focus-line")).toHaveCount(1);
  });

  test("the newer half is inert at the latest window", async ({ page }) => {
    const frame = await open(page, "stacked-load-d-axis-tap-latest");
    const s = await strip(page);
    const mid = (s.left + s.right) / 2;

    await page.touchscreen.tap((mid + s.right) / 2, s.top + 20);
    await expect(frame).toHaveAttribute("data-axis-tap", "none");

    // Older still steps — `canGoNewer` gates one half, not the strip.
    await page.touchscreen.tap((s.left + mid) / 2, s.top + 20);
    await expect(frame).toHaveAttribute("data-axis-tap", "older");
  });

  test("a horizontal drag scrubs the crosshair instead of stepping", async ({
    page,
  }) => {
    // `TAP_SLOP` is what separates the two gestures, and it is the one that fails silently: without
    // it, scrubbing the crosshair along the axis fires a window step on every release.
    //
    // 🛑 Driven through CDP, not `dispatchEvent`. A synthetic `pointerdown` built by
    // `locator.dispatchEvent` carries `pointerType: ""`, so `DashboardChart` never records a tap
    // start and the test passes whatever the slop logic does — verified by deleting the slop check
    // and watching the dispatchEvent version stay green. `Input.dispatchTouchEvent` produces real
    // touch input, which Chromium turns into pointer events with `pointerType: "touch"`.
    const frame = await open(page, "stacked-load-d-axis-tap");
    const s = await strip(page);
    const y = s.top + 20;
    const from = (s.left + s.right) / 2;

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }],
      });

    await touch("touchStart", from);
    await touch("touchMove", from + 60);
    await touch("touchEnd", from + 60);

    await expect(frame).toHaveAttribute("data-axis-tap", "none");

    // The same gesture WITHOUT the travel does step, so the guard is the distance and not the
    // transport — otherwise this test would also pass against a chart that ignored touch entirely.
    await touch("touchStart", from);
    await touch("touchEnd", from);
    await expect(frame).toHaveAttribute("data-axis-tap", "newer");
  });
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
