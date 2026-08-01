"use client";

/**
 * Chart gallery — renders each `CHART_CASES` entry from deterministic fixtures, at a fixed size, with
 * no network and no clocks. Internal, dev/preview-only (see ./page.tsx).
 *
 * This is the screenshot target for `e2e/charts.spec.ts`. Two rules keep the baselines honest:
 *
 *  1. **Render today's behaviour, warts included.** Several cases exist specifically to pin a known
 *     defect (see `../../../docs/plans/chart-library-consolidation.md`). Do not "helpfully" fix one
 *     here — the point is that the Stage 3 fix shows up as a reviewed baseline diff.
 *  2. **Nothing may vary between runs.** No `Date.now()`, no `Math.random()`, no fetching. The
 *     fixture module owns the frozen instant; the harness pins the browser timezone to match.
 *
 * `?case=<id>` renders one case alone (what the harness screenshots). No param renders the index.
 */
import { useRef } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import DashboardChart from "@/components/DashboardChart";
import ChartTooltip from "@/components/ChartTooltip";
import { CHART_CASES, type ChartCase } from "./cases";
import { linesFixture, stackedFixture } from "./fixtures";

const noop = () => {};

/** The focus instant for a case, or null — a fraction along the fixture's own timestamp array. */
function focusInstant(timestamps: Date[], focusAt?: number): Date | null {
  if (focusAt == null || timestamps.length === 0) return null;
  const i = Math.min(
    timestamps.length - 1,
    Math.max(0, Math.round((timestamps.length - 1) * focusAt)),
  );
  return timestamps[i];
}

/** Index of `t` in `timestamps`, for reading the legend values at the focus instant. */
function indexOf(timestamps: Date[], t: Date | null): number | null {
  if (!t) return null;
  const target = t.getTime();
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i].getTime() === target) return i;
  }
  return null;
}

function LinesCase({ c }: { c: Extract<ChartCase, { kind: "lines" }> }) {
  const chartRef = useRef<unknown>(null);
  const { chartData, paddedSOCData, windowStart, now } = linesFixture(c);
  const focus = focusInstant(chartData.timestamps, c.focusAt);
  const fi = indexOf(chartData.timestamps, focus);

  // Mirrors LinesChartCard: all-nulls when nothing is focused. That is what makes DEFECT #1 visible.
  const hovered =
    fi != null
      ? {
          solar: chartData.solar[fi] ?? null,
          load: chartData.load[fi] ?? null,
          battery: chartData.batteryW?.[fi] ?? null,
          grid: chartData.grid?.[fi] ?? null,
          batterySOC: chartData.batterySOC[fi] ?? null,
        }
      : {
          solar: null,
          load: null,
          battery: null,
          grid: null,
          batterySOC: null,
        };

  return (
    <div className="flex flex-col" style={{ width: c.width }}>
      {/* Explicit height: Chart.js runs with `maintainAspectRatio: false`, so an unsized parent
          leaves the canvas at its default height and the frame ends up mostly empty — which would
          dilute `maxDiffPixelRatio` and make the baseline less sensitive than it looks. */}
      <div style={{ height: c.height }}>
        <DashboardChart
          variant="lines"
          chartData={chartData}
          paddedSOCData={paddedSOCData}
          timeRange={c.range}
          now={now}
          windowStart={windowStart}
          hoveredTimestamp={focus}
          onHover={noop}
          chartRef={chartRef as React.MutableRefObject<unknown>}
          className="h-full"
        />
      </div>
      <div className="mt-2 flex justify-center">
        <ChartTooltip
          {...hovered}
          unit={chartData.mode === "energy" ? "kWh" : "kW"}
          visible={true}
        />
      </div>
    </div>
  );
}

function StackedCase({ c }: { c: Extract<ChartCase, { kind: "stacked" }> }) {
  const chartRef = useRef<unknown>(null);
  const { chartData, visibleSeries, windowStart, now } = stackedFixture(c);
  const focus = focusInstant(chartData.timestamps, c.focusAt);

  return (
    <div style={{ width: c.width, height: c.height }}>
      <DashboardChart
        variant="stacked-areas"
        chartData={chartData}
        effectiveVisibleSeries={visibleSeries}
        mode={c.mode}
        timeRange={c.range}
        now={now}
        windowStart={windowStart}
        hoveredTimestamp={focus}
        onHover={noop}
        chartRef={chartRef as React.MutableRefObject<unknown>}
        className="h-full"
      />
    </div>
  );
}

/** Both charts over one window — the dashboard arrangement, so the palettes can be compared. */
function ColoursCase({ c }: { c: Extract<ChartCase, { kind: "colours" }> }) {
  return (
    <div className="flex flex-col gap-4" style={{ width: c.width }}>
      <div>
        <div className="mb-1 text-xs text-gray-500">
          lines — Solar yellow-400 · Load blue-400 · Battery orange-400 · Grid
          red-500 · SoC green-400
        </div>
        <LinesCase
          c={{
            id: `${c.id}-lines`,
            kind: "lines",
            note: c.note,
            range: c.range,
            focusAt: c.focusAt,
            width: c.width,
            height: c.height,
          }}
        />
      </div>
      <div>
        <div className="mb-1 text-xs text-gray-500">
          stacked — resolved through CHART_COLORS (Solar yellow-200 · Battery
          green-400 · Grid pink-500 · HWS orange-400 · EV red-600)
        </div>
        <StackedCase
          c={{
            id: `${c.id}-stacked`,
            kind: "stacked",
            note: c.note,
            range: c.range,
            mode: c.mode,
            focusAt: c.focusAt,
            width: c.width,
            height: c.height,
          }}
        />
      </div>
    </div>
  );
}

function CaseBody({ c }: { c: ChartCase }) {
  if (c.kind === "lines") return <LinesCase c={c} />;
  if (c.kind === "stacked") return <StackedCase c={c} />;
  return <ColoursCase c={c} />;
}

/**
 * The screenshot target. `data-case-ready` is what the harness waits on, and the fixed pixel box is
 * what it clips to — never the viewport, so an unrelated layout change can't churn every baseline.
 */
function CaseFrame({ c }: { c: ChartCase }) {
  return (
    <div
      data-testid="chart-case"
      data-case-id={c.id}
      data-case-ready="true"
      className="inline-block bg-gray-900 p-4"
      style={{ width: c.width + 32 }}
    >
      <CaseBody c={c} />
    </div>
  );
}

export default function ChartGallery() {
  const params = useSearchParams();
  const caseId = params.get("case");

  if (caseId) {
    const c = CHART_CASES.find((x) => x.id === caseId);
    if (!c) {
      return (
        <div className="p-8 text-red-400">
          Unknown case <code>{caseId}</code>. Known:{" "}
          {CHART_CASES.map((x) => x.id).join(", ")}
        </div>
      );
    }
    return (
      <main className="min-h-screen bg-gray-900 p-4">
        <CaseFrame c={c} />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 p-6 text-gray-200">
      <h1 className="mb-1 text-xl font-semibold">Chart gallery</h1>
      <p className="mb-6 max-w-3xl text-sm text-gray-400">
        Deterministic fixtures for the Chart.js → d3 migration baselines. Cases
        marked DEFECT render a known bug on purpose — see{" "}
        <code>docs/plans/chart-library-consolidation.md</code>.
      </p>
      <ul className="mb-8 space-y-1 text-sm">
        {CHART_CASES.map((c) => (
          <li key={c.id}>
            <Link
              href={`/labs/chart-gallery?case=${c.id}`}
              className="text-blue-400 hover:underline"
            >
              {c.id}
            </Link>
            <span className="text-gray-500"> — {c.note}</span>
          </li>
        ))}
      </ul>
      <div className="space-y-10">
        {CHART_CASES.map((c) => (
          <section key={c.id}>
            <h2 className="mb-1 font-mono text-sm text-gray-300">{c.id}</h2>
            <p className="mb-2 text-xs text-gray-500">{c.note}</p>
            <CaseFrame c={c} />
          </section>
        ))}
      </div>
    </main>
  );
}
