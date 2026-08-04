"use client";

/**
 * Chart gallery — renders each `CHART_CASES` entry from deterministic fixtures, at a fixed size, with
 * no network and no clocks. Internal, dev/preview-only (see ./page.tsx).
 *
 * This is the screenshot target for `e2e/charts.spec.ts`. Two rules keep the baselines honest:
 *
 *  1. **Render the real components' behaviour, warts included.** Several cases exist to pin a
 *     specific defect (see `../../../docs/plans/chart-library-consolidation.md`); their notes say
 *     which, and whether it is fixed yet. Never work around a defect *here* — a fix belongs in the
 *     component, so it lands as a reviewed baseline diff. Equally, when a fix lands, update the
 *     fixture to match the real builder rather than freezing the old shape.
 *  2. **Nothing may vary between runs.** No `Date.now()`, no `Math.random()`, no fetching. The
 *     fixture module owns the frozen instant; the harness pins the browser timezone to match.
 *
 * `?case=<id>` renders one case alone (what the harness screenshots). No param renders the index.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import DashboardChart from "@/components/DashboardChart";
import ChartTooltip from "@/components/ChartTooltip";
import ProvenanceChart from "@/components/battery-provenance/ProvenanceChart";
// 🛑 Imported for its CASES *and* deliberately for its side effects — do NOT drop either.
//
// The real dashboard loads every chart module: `components/dashboard/registry.tsx` statically imports
// all 20 card plugins, so `HeatmapChart` is in the graph of every dashboard page whether or not a
// heatmap card is on it. A gallery that imported only `DashboardChart` was therefore screenshotting
// something the dashboard never actually renders — and that is not hypothetical: until defect #7 was
// fixed, HeatmapChart globally registered a y-axis plugin that re-drew the tick labels of every other
// Chart.js chart in the process (ghosted axis labels, live in production).
//
// Keeping the import here makes the baselines faithful AND makes this a permanent regression guard:
// re-introduce a `ChartJS.register(...)` of a chart-specific plugin anywhere in this graph and every
// lines/stacked baseline fails immediately.
import HeatmapChart from "@/components/HeatmapChart";
import PrimitivesDemo from "./PrimitivesDemo";
import IngestionChart from "@/app/admin/observations/IngestionChart";
import { CHART_COLORS } from "@/lib/chart-colors";
import { CHART_CASES, type ChartCase } from "./cases";
import {
  ingestionFixture,
  linesFixture,
  provenanceFixture,
  runBandsFixture,
  stackedFixture,
} from "./fixtures";

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
  const { chartData, paddedSOCData, windowStart, windowEnd } = linesFixture(c);
  const focus = focusInstant(chartData.timestamps, c.focusAt);
  const fi = indexOf(chartData.timestamps, focus);

  // Mirrors LinesChartCard exactly: all-nulls when nothing is focused. Presence is passed separately
  // (hasBattery/hasGrid below) — conflating the two was defect #1/#2.
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
          windowEnd={windowEnd}
          windowStart={windowStart}
          hoveredTimestamp={focus}
          onHoverIndex={noop}
          className="h-full"
        />
      </div>
      <div className="mt-2 flex justify-center">
        <ChartTooltip
          {...hovered}
          hasBattery={chartData.batteryW != null}
          hasGrid={chartData.grid != null}
          unit={chartData.mode === "energy" ? "kWh" : "kW"}
        />
      </div>
    </div>
  );
}

function StackedCase({ c }: { c: Extract<ChartCase, { kind: "stacked" }> }) {
  // Only the run cases taper the EV band, so the other stacked baselines keep the square wave they
  // were drawn with — see `StackedCaseOpts.evRamp`.
  const fixture = stackedFixture({ ...c, evRamp: c.withRuns });
  const { chartData, visibleSeries, windowStart, windowEnd } = fixture;
  const focus = focusInstant(chartData.timestamps, c.focusAt);
  const runBands = c.withRuns ? runBandsFixture(fixture) : undefined;

  return (
    <div style={{ width: c.width, height: c.height }}>
      <DashboardChart
        variant="stacked-areas"
        chartData={chartData}
        effectiveVisibleSeries={visibleSeries}
        mode={c.mode}
        timeRange={c.range}
        windowEnd={windowEnd}
        windowStart={windowStart}
        hoveredTimestamp={focus}
        onHoverIndex={noop}
        runBands={runBands}
        // The hovered state is driven by the CASE, not by a pointer: a screenshot cannot hover, and
        // the whole point of the pair is to show that hovering changes the ink.
        hoveredRunId={c.hoveredRun ? (runBands?.[0]?.id ?? null) : null}
        className="h-full"
      />
    </div>
  );
}

/**
 * The stacked chart in the dashboard's real height chain — the classes are copied verbatim from
 * `SiteChartsCard`'s load block, and the only thing asserted is that a chart comes out of it.
 *
 * 🛑 Nothing here may set a height. The chain is the subject: the chart's box is derived from
 * `min-h-[375px]` several levels up, and `DashboardChart` draws NOTHING when its own root measures
 * zero — so a height that fails to resolve is a silent blank, which is exactly how it shipped
 * (#350, mobile only, two days live). The harness's "a canvas or svg acquired a size" poll is what
 * turns that into a test failure, so this case needs no assertion of its own.
 */
function SiteLayoutCase({
  c,
}: {
  c: Extract<ChartCase, { kind: "site-layout" }>;
}) {
  const fixture = stackedFixture({ range: c.range, mode: c.mode });
  const { chartData, visibleSeries, windowStart, windowEnd } = fixture;

  return (
    <div style={{ width: c.width }}>
      <div className="flex flex-col md:flex-row md:gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-col h-full" style={{ minHeight: c.height }}>
            <div className="relative flex-1 min-h-0 w-full">
              <DashboardChart
                variant="stacked-areas"
                chartData={chartData}
                effectiveVisibleSeries={visibleSeries}
                mode={c.mode}
                timeRange={c.range}
                windowEnd={windowEnd}
                windowStart={windowStart}
                hoveredTimestamp={null}
                onHoverIndex={noop}
                className="absolute inset-0 overflow-hidden"
              />
            </div>
          </div>
        </div>
        {/* Stands in for the EnergyTable: same box, no data — it is here because it is what makes
            the row branch's cross size definite, which is why desktop never saw the bug. */}
        <div className="w-full md:w-64 mt-4 md:mt-0 flex-shrink-0">
          <div className="h-[260px] rounded border border-gray-700 bg-gray-800/40 p-2 text-xs text-gray-500">
            legend
          </div>
        </div>
      </div>
    </div>
  );
}

/** Both charts over one window — the dashboard arrangement, so the palettes can be compared. */
function ColoursCase({ c }: { c: Extract<ChartCase, { kind: "colours" }> }) {
  return (
    <div className="flex flex-col gap-4" style={{ width: c.width }}>
      <div>
        <div className="mb-1 text-xs text-gray-500">
          lines — resolved through CHART_COLORS (Solar yellow-200 · Load
          blue-400 · Battery green-400 · Grid pink-500 · SoC green-400 DASHED)
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
          stacked — the same CHART_COLORS registry (Solar yellow-200 · Battery
          green-400 · Grid pink-500 · HWS orange-400 · EV red-600). Both panels
          agree since Stage 3c; pink means Grid in both, and orange/red no
          longer mean two different things across the pair.
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

function ProvenanceCase({
  c,
}: {
  c: Extract<ChartCase, { kind: "provenance" }>;
}) {
  const f = provenanceFixture(c);
  const focus = focusInstant(f.timestamps, c.focusAt);
  return (
    <div style={{ width: c.width }}>
      <ProvenanceChart
        def={f.def}
        timestamps={f.timestamps}
        seriesValues={f.seriesValues}
        visibleSeries={f.visibleSeries}
        hoveredTimestamp={focus}
        onHoverIndexChange={noop}
        timeRange={c.range}
        windowStart={f.windowStart}
        windowEnd={f.windowEnd}
        bandAnnotations={f.bandAnnotations}
      />
    </div>
  );
}

function HeatmapCase({ c }: { c: Extract<ChartCase, { kind: "heatmap" }> }) {
  // No props carry the data — HeatmapChart issues its own /api/history query, which the harness
  // intercepts. See `heatmapHistoryFixture`.
  return (
    <div style={{ width: c.width }}>
      <HeatmapChart
        systemId={1}
        pointPath={c.pointPath}
        pointUnit={c.pointUnit}
        metricType={c.metricType}
        timezone={c.timezone}
        dayOffsetMin={c.dayOffsetMin}
        palette={c.palette}
      />
    </div>
  );
}

function PrimitivesCase({
  c,
}: {
  c: Extract<ChartCase, { kind: "primitives" }>;
}) {
  // Reuses the lines/stacked fixtures so the demo is fed exactly what the real charts are.
  const lf = linesFixture({ range: c.range, withGap: c.withGap });
  const sf = c.withStack
    ? stackedFixture({ range: c.range, mode: "load", withGap: c.withGap })
    : null;
  const focus = focusInstant(lf.chartData.timestamps, c.focusAt);

  return (
    <PrimitivesDemo
      range={c.range}
      timestamps={lf.chartData.timestamps}
      lines={[
        {
          key: "solar",
          colour: CHART_COLORS.solar.primary,
          values: lf.chartData.solar,
        },
        { key: "load", colour: CHART_COLORS.load, values: lf.chartData.load },
      ]}
      stack={
        sf
          ? sf.chartData.series
              .filter((s) => s.seriesType !== "soc")
              .map((s) => ({ key: s.id, colour: s.color, values: s.data }))
          : undefined
      }
      soc={lf.chartData.batterySOC}
      focus={focus}
      width={c.width}
      height={c.height}
    />
  );
}

function IngestionCase({
  c,
}: {
  c: Extract<ChartCase, { kind: "ingestion" }>;
}) {
  return (
    <div style={{ width: c.width }}>
      <IngestionChart series={ingestionFixture(c)} loading={false} configured />
    </div>
  );
}

function CaseBody({ c }: { c: ChartCase }) {
  if (c.kind === "lines") return <LinesCase c={c} />;
  if (c.kind === "stacked") return <StackedCase c={c} />;
  if (c.kind === "provenance") return <ProvenanceCase c={c} />;
  if (c.kind === "heatmap") return <HeatmapCase c={c} />;
  if (c.kind === "primitives") return <PrimitivesCase c={c} />;
  if (c.kind === "ingestion") return <IngestionCase c={c} />;
  if (c.kind === "site-layout") return <SiteLayoutCase c={c} />;
  return <ColoursCase c={c} />;
}

/**
 * True once webfonts have loaded.
 *
 * 🛑 Load-bearing for baseline stability, not a nicety. Chart.js measures tick-label widths at its
 * FIRST layout and never re-measures when a font arrives later. Mounting before DM Sans is ready
 * therefore sizes the axes with the fallback font, which shifts `chartArea` — and with it every
 * cell/bar/point position — by a sub-pixel amount that varies with load timing. It made the heatmap
 * cases flaky between runs (they have 60 rotated tick labels, so the error accumulates instead of
 * rounding away); the other charts were quietly exposed to the same race.
 *
 * Waiting in the test instead does not work: by then the chart has already laid out.
 */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

/**
 * The screenshot target. `data-case-ready` is what the harness waits on — it only flips true once
 * fonts have loaded AND the case has mounted. The fixed pixel box is what the harness clips to,
 * never the viewport, so an unrelated layout change can't churn every baseline.
 */
function CaseFrame({ c }: { c: ChartCase }) {
  const fontsReady = useFontsReady();
  return (
    <div
      data-testid="chart-case"
      data-case-id={c.id}
      data-case-ready={fontsReady ? "true" : "false"}
      className="inline-block bg-gray-900 p-4"
      style={{ width: c.width + 32 }}
    >
      {fontsReady ? <CaseBody c={c} /> : null}
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
