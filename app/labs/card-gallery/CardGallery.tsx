"use client";

/**
 * Card gallery — renders every pure-presentational dashboard card across a preset size matrix
 * and a resizable playground, driven by hand-crafted mock data (see ./fixtures). Internal,
 * dev/preview-only (see app/labs/card-gallery/page.tsx). Purely additive: cards are rendered
 * as-is to *find* sizing problems, not to fix them.
 */
import React, { useEffect, useRef, useState } from "react";
import AmberSmallCard from "@/components/AmberSmallCard";
import TeslaSmallCard from "@/components/TeslaSmallCard";
import AmberNow from "@/components/AmberNow";
import GridSignalsCard from "@/components/GridSignalsCard";
import BatteryContentsCard from "@/components/BatteryContentsCard";
import { TILE_RENDERERS } from "@/components/dashboard/tiles/registry";
import type { TileId } from "@/lib/dashboard/cards";
import type { LatestPointValues } from "@/lib/types/api";
import {
  SOLAR_SCENARIOS,
  LOAD_SCENARIOS,
  BATTERY_SCENARIOS,
  GRID_SCENARIOS,
  AMBER_SCENARIOS,
  TESLA_SCENARIOS,
  GRID_SIGNALS_SCENARIOS,
  BATTERY_CONTENTS_SCENARIOS,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Renders a single tile faithfully via the real tile plugin (no systemId → no live fetches). */
function TileCell({ latest, id }: { latest: LatestPointValues; id: TileId }) {
  const { Render } = TILE_RENDERERS[id];
  return (
    <Render
      latest={latest}
      data={null}
      staleThresholdSeconds={300}
      showGrid={true}
      canControl={false}
    />
  );
}

/** Segmented state picker. */
function StatePicker({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 rounded text-xs border transition-colors ${
            value === opt
              ? "bg-blue-600 border-blue-500 text-white"
              : "bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

/** A width-fixed preset cell (height natural). Card fills the width as a block. */
function PresetCell({
  width,
  children,
}: {
  width: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-gray-500">{width}px</span>
      <div style={{ width }}>{children}</div>
    </div>
  );
}

/** A drag-to-resize box (both axes). Uses display:grid so the single child fills it. */
function Resizable({
  initialW,
  initialH,
  children,
}: {
  initialW: number;
  initialH: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: initialW, h: initialH });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) {
        setSize({
          w: Math.round(e.contentRect.width),
          h: Math.round(e.contentRect.height),
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div className="relative inline-block pt-5">
      <span className="absolute top-0 left-0 text-[10px] text-gray-400 font-mono">
        {size.w} × {size.h}
      </span>
      <div
        ref={ref}
        style={{
          width: initialW,
          height: initialH,
          resize: "both",
          overflow: "hidden",
          display: "grid",
        }}
        className="border border-dashed border-gray-600 rounded"
      >
        {children}
      </div>
    </div>
  );
}

/** One card family section: state picker + preset row + resizable playground. */
function CardSection({
  title,
  note,
  scenarios,
  defaultScenario,
  render,
  presetWidths,
  playground,
}: {
  title: string;
  note?: string;
  scenarios: string[];
  defaultScenario: string;
  render: (scenario: string) => React.ReactNode;
  presetWidths: number[];
  playground: { w: number; h: number };
}) {
  const [scenario, setScenario] = useState(defaultScenario);
  return (
    <section className="mb-12 border-b border-gray-800 pb-10">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">{title}</h2>
      {note && <p className="text-xs text-gray-500 mb-3">{note}</p>}
      <StatePicker
        options={scenarios}
        value={scenario}
        onChange={setScenario}
      />

      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Preset widths
      </h3>
      <div className="flex flex-wrap items-end gap-4 mb-8">
        {presetWidths.map((w) => (
          <PresetCell key={w} width={w}>
            {render(scenario)}
          </PresetCell>
        ))}
      </div>

      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Resizable playground (drag bottom-right corner)
      </h3>
      <Resizable initialW={playground.w} initialH={playground.h}>
        {render(scenario)}
      </Resizable>
    </section>
  );
}

// Container-query cards re-layout at their own width: 66 / 90 / 120 / 180 / 300.
const CQ_WIDTHS = [66, 80, 90, 110, 120, 150, 180, 220, 300, 380];
// Tile / GridSignals key off the md: (768px) VIEWPORT width, not container width.
const POWER_WIDTHS = [80, 110, 150, 180, 220, 300];
const GRID_WIDTHS = [180, 260, 340, 440, 560];
const AMBERNOW_WIDTHS = [220, 280, 340, 420];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function CardGallery() {
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).has("debug"));
  }, []);

  const toggleDebug = () => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("debug")) url.searchParams.delete("debug");
    else url.searchParams.set("debug", "");
    window.location.href = url.toString();
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-white">Card Gallery</h1>
          <p className="text-sm text-gray-400 mt-1">
            Every pure-presentational dashboard card at many sizes, with
            hand-crafted mock data. Use this to spot which cards don&apos;t
            render well at a given size.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={toggleDebug}
              className={`px-3 py-1.5 rounded text-xs border ${
                debug
                  ? "bg-red-600 border-red-500 text-white"
                  : "bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700"
              }`}
            >
              {debug
                ? "Hide size badges (?debug)"
                : "Show size badges (?debug)"}
            </button>
            <span className="text-xs text-gray-500">
              Note: Tile &amp; Local Grid switch mobile↔desktop at the 768px{" "}
              <em>browser-window</em> width, not container width — resize the
              window to exercise that flip.
            </span>
          </div>
        </header>

        <CardSection
          title="Power — Solar"
          note="Tile. Viewport (md:) breakpoint layout. 'local + remote' shows the breakdown rows."
          scenarios={Object.keys(SOLAR_SCENARIOS)}
          defaultScenario="local + remote"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s) => <TileCell latest={SOLAR_SCENARIOS[s]} id="solar" />}
        />

        <CardSection
          title="Power — Load"
          note="Tile. 'with children' shows top-2 child loads + synthesized rest-of-house."
          scenarios={Object.keys(LOAD_SCENARIOS)}
          defaultScenario="with children"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s) => <TileCell latest={LOAD_SCENARIOS[s]} id="load" />}
        />

        <CardSection
          title="Power — Battery"
          note="Tile. Color + flow chevrons follow charge/discharge sign; 'stale' dims + hatches."
          scenarios={Object.keys(BATTERY_SCENARIOS)}
          defaultScenario="charging"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s) => (
            <TileCell latest={BATTERY_SCENARIOS[s]} id="battery" />
          )}
        />

        <CardSection
          title="Power — Grid"
          note="Tile. Import (red) / export (green) / idle; double chevron above 5kW."
          scenarios={Object.keys(GRID_SCENARIOS)}
          defaultScenario="importing"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s) => (
            <TileCell latest={GRID_SCENARIOS[s]} id="house-to-grid" />
          )}
        />

        <CardSection
          title="Amber — small card"
          note="Container-query layout: 66 / 90 / 120 / 180 / 300 width breakpoints. Returns null if no import rate."
          scenarios={Object.keys(AMBER_SCENARIOS)}
          defaultScenario="low"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 200, h: 180 }}
          render={(s) => <AmberSmallCard latest={AMBER_SCENARIOS[s]} />}
        />

        <CardSection
          title="Tesla — small card"
          note="Container-query layout: 66 / 90 / 120 / 180 width breakpoints. Returns null if no SoC."
          scenarios={Object.keys(TESLA_SCENARIOS)}
          defaultScenario="charging (high power)"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 200, h: 180 }}
          render={(s) => <TeslaSmallCard latest={TESLA_SCENARIOS[s]} />}
        />

        <CardSection
          title="Local Grid (NEM) signals"
          note="GridSignalsCard. 3-up stat grid; needs width. 'missing metric' shows an em-dash; 'stale' dims."
          scenarios={Object.keys(GRID_SIGNALS_SCENARIOS)}
          defaultScenario="high renewables"
          presetWidths={GRID_WIDTHS}
          playground={{ w: 360, h: 130 }}
          render={(s) => {
            const f = GRID_SIGNALS_SCENARIOS[s];
            return (
              <GridSignalsCard regionLabel={f.regionLabel} values={f.values} />
            );
          }}
        />

        <CardSection
          title="Amber — Now (large circle)"
          note="AmberNow. Large live-price circle (Amber dashboard hero)."
          scenarios={Object.keys(AMBER_SCENARIOS)}
          defaultScenario="low"
          presetWidths={AMBERNOW_WIDTHS}
          playground={{ w: 320, h: 360 }}
          render={(s) => <AmberNow latest={AMBER_SCENARIOS[s]} />}
        />

        <CardSection
          title="Battery Contents"
          note="BatteryContentsCard. Labelled stat grid (2→3→4 cols). 'warm-up' shows em-dash totals; 'no tariff' hides the export/opportunity split; 'empty battery' reads 0.0 kWh; 'stale' dims."
          scenarios={Object.keys(BATTERY_CONTENTS_SCENARIOS)}
          defaultScenario="typical"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 380, h: 150 }}
          render={(s) => (
            <BatteryContentsCard values={BATTERY_CONTENTS_SCENARIOS[s]} />
          )}
        />
      </div>
    </div>
  );
}
