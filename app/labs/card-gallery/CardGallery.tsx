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
import HwsSmallCard from "@/components/HwsSmallCard";
import AmberNow from "@/components/AmberNow";
import GridSignalsCard from "@/components/GridSignalsCard";
import BatteryContentsCard from "@/components/BatteryContentsCard";
import HomeEnergyCard from "@/components/HomeEnergyCard";
import { CARD_RENDERERS } from "@/components/dashboard/registry";
import type { TileId } from "@/lib/dashboard/card-types";
import type { LatestPointValues } from "@/lib/types/api";
import { useQueryClient } from "@tanstack/react-query";
import GeneratorControlDialog from "@/components/GeneratorControlDialog";
import TeslaControlDialog from "@/components/TeslaControlDialog";
import { installControlStub, type ControlScenarioName } from "./control-stub";
import {
  makeStale,
  SOLAR_SCENARIOS,
  LOAD_SCENARIOS,
  GENERATOR_SCENARIOS,
  GENERATOR_CONTROL_SCENARIOS,
  BATTERY_SCENARIOS,
  GRID_SCENARIOS,
  AMBER_SCENARIOS,
  TESLA_CONTROL_SCENARIOS,
  TESLA_SCENARIOS,
  HWS_SCENARIOS,
  GRID_SIGNALS_SCENARIOS,
  BATTERY_CONTENTS_SCENARIOS,
  HOME_ENERGY_SCENARIOS,
} from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick a scenario out of its map, aged if the section's stale box is ticked.
 *
 * The one place the checkbox meets the fixtures. Every section reads its map through this, so a
 * card that quietly ignores staleness shows it here rather than needing a fixture to prove it.
 */
function pick<T>(map: Record<string, T>, scenario: string, stale: boolean): T {
  const fixture = map[scenario];
  return stale ? makeStale(fixture) : fixture;
}

/**
 * Generator scenarios whose engine is TURNING **and whose run the detector has already opened** —
 * the stubbed run-periods returns an open run for these.
 *
 * 🛑 "starting (ours)" is deliberately ABSENT even though its engine is turning. The run detector
 * needs a minute or two to open a period after a start, and the tile's rule is to show NOTHING in
 * that window rather than the previous period's totals under a hero that says the engine is going.
 * Leaving it out is what makes that window reviewable here.
 */
const RUNNING_SCENARIOS = new Set([
  "running (ours)",
  "running (inverter)",
  "cooling down",
  "running, panel locked",
  "stop failing",
  "still running after release",
]);

/**
 * The two device handles the generator tile is rendered under.
 *
 * Two, not one, because the tile appears in two sections with independent scenario pickers, and the
 * run-periods answer is keyed by handle — one shared handle would mean a pick in either section
 * rewrote the other section's Generated row.
 */
const GEN_HANDLE_PLAIN = 15;
const GEN_HANDLE_CONTROL = 14;

/**
 * Renders a single tile faithfully via the real tile plugin.
 *
 * `systemId` is undefined by default, which keeps most sections free of fetches entirely — a tile
 * only queries when it has a subject to query about.
 *
 * Pass one to review the rows that need a server answer (the generator's Generated kWh/$ row comes
 * from run-periods, not from `latest`); the gallery's fetch stub answers `/api/data`, run-periods
 * and every control route, so those rows render rather than 404ing away. `canControl` is a SEPARATE
 * knob and the two are independent on purpose: a viewer who cannot command a generator still has a
 * subject and still sees its Generated row, so tying the row to the cog would have modelled a
 * viewer who does not exist.
 */
function TileCell({
  latest,
  id,
  canControl = false,
  systemId,
}: {
  latest: LatestPointValues;
  id: TileId;
  canControl?: boolean;
  systemId?: number;
}) {
  const { Render } = CARD_RENDERERS[id];
  return (
    <Render
      latest={latest}
      data={null}
      systemId={systemId}
      staleThresholdSeconds={300}
      showGrid={true}
      canControl={canControl}
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
  onScenarioChange,
}: {
  title: string;
  note?: string;
  scenarios: string[];
  defaultScenario: string;
  render: (scenario: string, stale: boolean) => React.ReactNode;
  presetWidths: number[];
  playground: { w: number; h: number };
  /** Lets the page react to the picked state — the generator's stubbed run-periods follows it. */
  onScenarioChange?: (scenario: string) => void;
}) {
  const [scenario, setScenarioState] = useState(defaultScenario);
  const [stale, setStale] = useState(false);
  const setScenario = (next: string) => {
    setScenarioState(next);
    onScenarioChange?.(next);
  };
  return (
    <section className="mb-12 border-b border-gray-800 pb-10">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">{title}</h2>
      {note && <p className="text-xs text-gray-500 mb-3">{note}</p>}
      <div className="flex flex-wrap items-start gap-x-4">
        <StatePicker
          options={scenarios}
          value={scenario}
          onChange={setScenario}
        />
        {/* A CHECKBOX, not a scenario. Staleness is orthogonal to what the card is showing — a
            generator can be stale while running, while locked out, or while cooling down — and as
            one more mutually-exclusive pill it could only ever express the single stale state
            somebody had hand-written, which was always the least interesting one. */}
        <label className="mb-3 flex cursor-pointer select-none items-center gap-1.5 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={stale}
            onChange={(e) => setStale(e.target.checked)}
            className="accent-amber-500"
          />
          stale
        </label>
      </div>

      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Preset widths
      </h3>
      <div className="flex flex-wrap items-end gap-4 mb-8">
        {presetWidths.map((w) => (
          <PresetCell key={w} width={w}>
            {render(scenario, stale)}
          </PresetCell>
        ))}
      </div>

      <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
        Resizable playground (drag bottom-right corner)
      </h3>
      <Resizable initialW={playground.w} initialH={playground.h}>
        {render(scenario, stale)}
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

  /**
   * The control-plane fetch stub, installed for the WHOLE page.
   *
   * Page-level and not per-section on purpose: the generator tile fires its `/api/data` and
   * run-periods reads as soon as it mounts, so a stub installed by a section further down would
   * lose the race and the tile would render its empty state before the answers existed.
   *
   * Both live states follow the pickers through refs rather than the effect's deps, so changing a
   * scenario never reinstalls — a reinstall mid-flight would restore a stale `fetch` and leave the
   * page unpatched.
   */
  const queryClient = useQueryClient();
  const dialogScenario = useRef<ControlScenarioName>("ready to start");
  const genScenario = useRef<string>("auto (armed)");
  const genScenarioPlain = useRef<string>("running (ours)");
  // 🛑 Installed during RENDER, not in an effect. React runs CHILD effects before parent ones, so a
  // stub installed in this component's `useEffect` arrives after the tiles below have already fired
  // their queries — they 404, React Query caches the failure, and the rows the gallery exists to
  // show never appear. A `useState` initializer runs before any child renders at all.
  const [uninstall] = useState(() =>
    installControlStub({
      scenario: () => dialogScenario.current,
      // A run-periods answer must agree with the tile's own status word, or the tile would read
      // "Since 9:43am" over a hero that says the engine is stopped.
      runOpen: (systemId) =>
        RUNNING_SCENARIOS.has(
          systemId === GEN_HANDLE_CONTROL
            ? genScenario.current
            : genScenarioPlain.current,
        ),
    }),
  );
  useEffect(() => uninstall, [uninstall]);

  useEffect(() => {
    setDebug(new URLSearchParams(window.location.search).has("debug"));
  }, []);

  /**
   * 🛑 The gallery is CLIENT-RENDERED ONLY, and this gate is what makes it so.
   *
   * Every fixture in ./fixtures is stamped relative to `Date.now()` at module scope — measurement
   * times, staleness ages, `stopAt` deadlines. The server evaluates that module when it renders the
   * page and the browser evaluates it again when the bundle loads, so the two copies are however
   * many seconds or minutes apart the request took. Anything that renders a RELATIVE time then
   * disagrees across the boundary, and React reports a hydration mismatch — most visibly on the
   * generator tile's countdown ("stops in 23 min" server-side, "20 min" client-side).
   *
   * The fixtures are right to be relative: a gallery that pinned absolute instants would show a
   * generator whose run ended last August. The SSR pass is the part with no value here — nothing on
   * this page is indexed, shared, or first-paint sensitive — so skip it and let the client own the
   * clock. Placed after every hook, so the early return cannot change hook order.
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

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
          render={(s, st) => (
            <TileCell latest={pick(SOLAR_SCENARIOS, s, st)} id="solar" />
          )}
        />

        <CardSection
          title="Power — Load"
          note="Tile. 'with children' shows top-2 child loads + synthesized rest-of-house."
          scenarios={Object.keys(LOAD_SCENARIOS)}
          defaultScenario="with children"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s, st) => (
            <TileCell latest={pick(LOAD_SCENARIOS, s, st)} id="load" />
          )}
        />

        <CardSection
          title="Power — Battery"
          note="Tile. Color + flow chevrons follow charge/discharge sign; the stale box dims + hatches."
          scenarios={Object.keys(BATTERY_SCENARIOS)}
          defaultScenario="charging"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s, st) => (
            <TileCell latest={pick(BATTERY_SCENARIOS, s, st)} id="battery" />
          )}
        />

        <CardSection
          title="Power — Grid"
          note="Tile. Import (red) / export (green) / idle; double chevron above 5kW."
          scenarios={Object.keys(GRID_SCENARIOS)}
          defaultScenario="importing"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s, st) => (
            <TileCell latest={pick(GRID_SCENARIOS, s, st)} id="house-to-grid" />
          )}
        />

        <CardSection
          title="Generator"
          note="Tile as a viewer who canNOT control it: no cog, so the Gauge keeps the top-right corner. Status copy comes from the hub's own vocabulary, except idle, which splits on the panel mode: Auto means ARMED, anything else means LOCKED OUT, and an unread panel says neither. The time row prefers OUR run's remaining minutes and falls back to elapsed. The Generated row reads 'Since h:mma' with THIS RUN's energy while a run is open, 'This period' between runs, and NOTHING at all while the engine turns but the detector has not opened a period yet — pick 'starting (ours)' to see that window."
          scenarios={Object.keys(GENERATOR_SCENARIOS)}
          defaultScenario="running (ours)"
          onScenarioChange={(sc) => {
            genScenarioPlain.current = sc;
            // Same cache drop as the controls section below, for the same reason: the stubbed
            // run-periods answer depends on the pick but its query KEY does not.
            queryClient.removeQueries();
          }}
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s, st) => (
            <TileCell
              latest={pick(GENERATOR_SCENARIOS, s, st)}
              id="generator"
              systemId={GEN_HANDLE_PLAIN}
            />
          )}
        />

        <CardSection
          title="Generator — with controls"
          note="The same tile as a viewer who OWNS the generator: the cog moves into the top-right corner (where TeslaSmallCard puts its own, and where the Gauge used to sit) and opens the run controls. Same faked run-periods as the section above, on its own device handle so the two sections' pickers do not overwrite each other."
          scenarios={Object.keys(GENERATOR_CONTROL_SCENARIOS)}
          defaultScenario="auto (armed)"
          onScenarioChange={(sc) => {
            genScenario.current = sc;
            // The stubbed run-periods answer depends on this pick, but its query KEY does not — so
            // without dropping the cache the tile would keep the answer it got for the previous
            // scenario and show "This period" over a hero that says the engine is running.
            queryClient.removeQueries();
          }}
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(sc, st) => (
            <TileCell
              latest={pick(GENERATOR_CONTROL_SCENARIOS, sc, st)}
              id="generator"
              canControl
              systemId={GEN_HANDLE_CONTROL}
            />
          )}
        />

        <GeneratorDialogSection scenarioRef={dialogScenario} />

        <CardSection
          title="Hot Water"
          note="HwsSmallCard (a Tile). The only card with a TIGHT unit — '62.4°C' must read fused and UNMUTED, unlike '5.0 kW'. See docs/architecture/number-typography.md."
          scenarios={Object.keys(HWS_SCENARIOS)}
          defaultScenario="hot"
          presetWidths={POWER_WIDTHS}
          playground={{ w: 200, h: 140 }}
          render={(s, st) => (
            <HwsSmallCard
              {...pick(HWS_SCENARIOS, s, st)}
              staleThresholdSeconds={300}
            />
          )}
        />

        <CardSection
          title="Amber — small card"
          note="Container-query layout: 66 / 90 / 120 / 180 / 300 width breakpoints. Returns null if no import rate."
          scenarios={Object.keys(AMBER_SCENARIOS)}
          defaultScenario="low"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 200, h: 180 }}
          render={(s, st) => (
            <AmberSmallCard latest={pick(AMBER_SCENARIOS, s, st)} />
          )}
        />

        <CardSection
          title="Tesla — small card"
          note="One container-query layout: 66 / 90 / 120 / 180 width breakpoints. SoC donut matches Amber's disc at every step. Returns null if no SoC. Has NO staleness treatment — the stale box visibly does nothing here."
          scenarios={Object.keys(TESLA_SCENARIOS)}
          defaultScenario="charging (high power)"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 200, h: 180 }}
          render={(s, st) => (
            <TeslaSmallCard latest={pick(TESLA_SCENARIOS, s, st)} />
          )}
        />

        <TeslaDialogSection />

        <CardSection
          title="Local Grid (NEM) signals"
          note="GridSignalsCard. 3-up stat grid; needs width. 'missing metric' shows an em-dash; the stale box dims."
          scenarios={Object.keys(GRID_SIGNALS_SCENARIOS)}
          defaultScenario="high renewables"
          presetWidths={GRID_WIDTHS}
          playground={{ w: 360, h: 130 }}
          render={(s, st) => {
            const f = pick(GRID_SIGNALS_SCENARIOS, s, st);
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
          render={(s, st) => <AmberNow latest={pick(AMBER_SCENARIOS, s, st)} />}
        />

        <CardSection
          title="Battery Contents"
          note="BatteryContentsCard. Labelled stat grid (2→3→4 cols). 'warm-up' shows em-dash totals; 'no tariff' hides the export/opportunity split; 'empty battery' reads 0.0 kWh; the stale box dims."
          scenarios={Object.keys(BATTERY_CONTENTS_SCENARIOS)}
          defaultScenario="typical"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 380, h: 150 }}
          render={(s, st) => (
            <BatteryContentsCard
              values={pick(BATTERY_CONTENTS_SCENARIOS, s, st)}
            />
          )}
        />

        <CardSection
          title="Home Energy"
          note="HomeEnergyCard. Same shape as Battery Contents, over the navigator's period. 'grid only' reads Self-use '—'; 'partial self-renewable' em-dashes BOTH ratios; 'no intensities' em-dashes the rate/emissions stats; 'no data' is the empty state."
          scenarios={Object.keys(HOME_ENERGY_SCENARIOS)}
          defaultScenario="typical"
          presetWidths={CQ_WIDTHS}
          playground={{ w: 380, h: 200 }}
          // HomeEnergyCard takes its instant as a PROP rather than inside the summary, so the
          // checkbox has to age that argument rather than the fixture.
          render={(s, st) => (
            <HomeEnergyCard
              summary={HOME_ENERGY_SCENARIOS[s]}
              periodLabel="24 hours"
              measurementTime={
                st ? new Date(Date.now() - 20 * 60_000) : new Date()
              }
            />
          )}
        />
      </div>
    </div>
  );
}

/**
 * The generator control DIALOG, driven by canned hub answers.
 *
 * Not a `CardSection`: a dialog has no size matrix to sweep, and what needs sweeping instead is the
 * hub's ANSWER — the verdicts, the latched branch, the failures. Each scenario is one canned
 * preflight body (see ./control-stub), so every state the dialog can reach is one click away
 * instead of one diesel engine away.
 *
 * The stub is installed while this section is mounted and removed when it unmounts, so nothing else
 * in the gallery — or in the app, if you navigate away — sees a patched `fetch`.
 */
/**
 * The charge-control dialog, without a car.
 *
 * The sibling of `GeneratorDialogSection`, and here for the same two reasons: it is the only way to
 * look at a control dialog without live hardware, and it shares `CommandActivityLog` with the
 * generator — so a change to that component has to be checked in both places or it is only half
 * reviewed.
 *
 * Unlike the generator's, this dialog has no preflight: `TeslaControlDialog` deliberately never
 * gates its buttons (a redundant press is a benign decline plus a free re-poll), so the scenario is
 * just the car's state. `areaId` is omitted, which is the prop-only path — no automations/limits
 * block. The fetch stub answers the command log and the action route.
 */
function TeslaDialogSection() {
  const SCENARIOS = Object.keys(TESLA_CONTROL_SCENARIOS);
  const [scenario, setScenario] = useState(SCENARIOS[0]);
  const [open, setOpen] = useState(false);

  return (
    <section className="mb-12 border-b border-gray-800 pb-10">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">
        Tesla charge control dialog
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        The charge dialog against each car state. Start/Stop and both setpoints
        are never disabled on a stale reading — the Tesla rule, and the opposite
        of the generator&rsquo;s gated Start. Shares{" "}
        <code>CommandActivityLog</code> with the generator dialog, so check both
        when that changes. Commands write nothing; the action route is stubbed.
      </p>
      <StatePicker
        options={SCENARIOS}
        value={scenario}
        onChange={setScenario}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:border-gray-500"
      >
        Open dialog
      </button>
      <TeslaControlDialog
        systemId={6}
        open={open}
        onOpenChange={setOpen}
        latest={TESLA_CONTROL_SCENARIOS[scenario]}
      />
    </section>
  );
}

function GeneratorDialogSection({
  scenarioRef,
}: {
  scenarioRef: React.MutableRefObject<ControlScenarioName>;
}) {
  const HUB_ANSWERS: ControlScenarioName[] = [
    "ready to start",
    "checking (skeleton)",
    "refused: panel not in Auto",
    "refused: engine already running",
    "already running (ISO instant)",
    "hub unreachable",
    "no control passkey",
  ];
  const ENGINE_STATES = Object.keys(GENERATOR_CONTROL_SCENARIOS);

  const [hubAnswer, setHubAnswer] = useState<ControlScenarioName>(
    HUB_ANSWERS[0],
  );
  const [engineState, setEngineState] = useState("auto (armed)");
  const [open, setOpen] = useState(false);
  scenarioRef.current = hubAnswer;

  return (
    <section className="mb-12 border-b border-gray-800 pb-10">
      <h2 className="text-lg font-semibold text-gray-100 mb-1">
        Generator control dialog
      </h2>
      <p className="text-xs text-gray-500 mb-3">
        Every hub answer, without hardware. &ldquo;checking&rdquo; holds the
        preflight open so the engine-check skeleton can be inspected — the box
        must not change height when it resolves. &ldquo;already running&rdquo;
        is the ICU case: the hub sends both a flat sentence carrying an ISO
        instant and a template, and the dialog must show a local time either
        way. Start writes nothing; the action route is stubbed too.
      </p>
      {/*
        TWO axes, because the dialog genuinely has two sources and they can disagree.
        The engine state used to be DERIVED from the hub answer ("already running" ⇒ running, else
        idle), which meant you could not tell what you were about to get and could not reach the
        combinations that matter most.

        🛑 The interesting picks are the MISMATCHED ones. `latest` is a pushed point up to a poll
        old; the preflight is a live Modbus read. When they disagree the dialog prefers the probe
        (see `useProbe` in GeneratorControlDialog) — so "engine: auto (armed)" + "hub: already
        running" is the tile-says-stopped-but-it-is-running case, and choosing it here is the only
        way to see that precedence actually holds.
      */}
      <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
        Hub answer (live preflight)
      </p>
      <StatePicker
        options={HUB_ANSWERS}
        value={hubAnswer}
        onChange={(v) => setHubAnswer(v as ControlScenarioName)}
      />
      <p className="mb-1 text-[10px] uppercase tracking-wide text-gray-500">
        Engine state (pushed points)
      </p>
      <StatePicker
        options={ENGINE_STATES}
        value={engineState}
        onChange={setEngineState}
      />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:border-gray-500"
      >
        Open dialog
      </button>
      <GeneratorControlDialog
        systemId={GEN_HANDLE_CONTROL}
        open={open}
        onOpenChange={setOpen}
        latest={GENERATOR_CONTROL_SCENARIOS[engineState]}
      />
    </section>
  );
}
