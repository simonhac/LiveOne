/**
 * Support module for `v4-render-props.test.ts` — the config-v4 prop-equivalence harness.
 *
 * NOT a test file (no `*.test.ts` suffix ⇒ never collected by any jest config). It holds the three
 * things the harness needs to be a real gate:
 *
 *   1. A CAPTURE STORE. Every mocked leaf component and every instrumented plugin pushes the exact
 *      props object it was handed. Nothing is summarised at capture time.
 *   2. A DETERMINISTIC SERIALISER (`serialise`) that turns those props into diffable JSON: keys
 *      sorted, `undefined` dropped, Dates/Sets/functions/React elements rendered as stable tags, and
 *      fixture objects that arrive BY REFERENCE collapsed to `<fixture …>` (so a plugin that ever
 *      passes a rebuilt/derived object instead of the one it was given shows up as a diff).
 *   3. The FIXTURE WORLD: the fake `/api/data` payloads behind the mocked `useAreaDatum`, and the
 *      area/device resolver inputs. All values are fixed constants — no clocks, no randomness.
 *
 * Instrumentation policy: the card/tile PLUGINS are the code under test, so they are wrapped, never
 * replaced — `instrumentRenderers` records the props and then renders the REAL plugin. Only the
 * leaf components each plugin renders into are mocked away.
 */
import * as React from "react";
import type { ReadableArea } from "@/lib/areas/list";
import type { ResolvedDevice } from "@/lib/dashboard/resolve-shell";
import { Area, Device, type AreaId, type DeviceId } from "@/lib/ids";
import type { LatestPointValues } from "@/lib/types/api";

// ---------------------------------------------------------------------------
// 1. Capture store
// ---------------------------------------------------------------------------

/** Props a mocked leaf component received, attributed to the plugin that rendered it. */
export interface LeafCapture {
  key: string;
  component: string;
  props: Record<string, unknown>;
}

/** The props a plugin's `Render` received — i.e. `CardRenderProps` / `TileRenderProps` verbatim. */
export interface PluginCapture {
  key: string;
  plugin: string;
  props: Record<string, unknown>;
}

export const leafCaptures: LeafCapture[] = [];
export const pluginCaptures: PluginCapture[] = [];

export function resetCaptures(): void {
  leafCaptures.length = 0;
  pluginCaptures.length = 0;
}

/**
 * Carries the enclosing plugin's snapshot key down to the leaf. A leaf renders AFTER its plugin
 * returns, so a module-level "current node" variable would already be stale — context is the only
 * correct attribution channel under `renderToStaticMarkup`.
 */
export const NodeKeyContext = React.createContext<string | null>(null);

/**
 * The ONE place that knows how a node identifies itself in a plugin's props. Since the
 * `CardRenderProps` port (config-v4 Phase 14 stage 6) that is `node.id`; before it, the synthesised
 * `card.id`. Both carried the SAME value (the adapter copied `node.id` straight across), which is
 * why the harness key space — and therefore the snapshot's top-level keys — survived the port
 * unchanged, and why every `leaves` entry stayed byte-identical.
 */
export function nodeKeyOf(
  props: Record<string, unknown>,
  fallback: string,
): string {
  const node = props.node as { id?: string } | undefined;
  return node?.id ?? fallback;
}

// ---------------------------------------------------------------------------
// 2. Serialiser
// ---------------------------------------------------------------------------

const fixtureTags = new WeakMap<object, string>();

/** Mark a fixture object so the snapshot records `<fixture name>` instead of inlining it. */
export function tagFixture<T extends object>(obj: T, name: string): T {
  fixtureTags.set(obj, name);
  return obj;
}

/** Name a React element's type, including `forwardRef`/`memo` wrappers (every lucide icon is one). */
function elementName(el: React.ReactElement): string {
  const t = el.type as unknown;
  if (typeof t === "string") return t;
  if (typeof t === "symbol") {
    return t === Symbol.for("react.fragment") ? "Fragment" : String(t);
  }
  if (typeof t === "function" || (typeof t === "object" && t !== null)) {
    const f = t as {
      displayName?: string;
      name?: string;
      render?: { displayName?: string; name?: string };
      type?: { displayName?: string; name?: string };
    };
    return (
      f.displayName ||
      f.name ||
      f.render?.displayName ||
      f.render?.name ||
      f.type?.displayName ||
      f.type?.name ||
      "Anonymous"
    );
  }
  return "Anonymous";
}

/** Deterministic, diff-friendly JSON for arbitrary prop values. `undefined` ⇒ the key is dropped. */
export function serialise(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value;
  if (t === "number") {
    return Number.isFinite(value as number) ? value : String(value);
  }
  if (t === "bigint" || t === "symbol") return String(value);
  if (t === "function") {
    const name = (value as { name?: string }).name;
    return `<fn ${name && name.length > 0 ? name : "anonymous"}>`;
  }
  if (value instanceof Date) return `<Date ${value.toISOString()}>`;
  if (value instanceof Set) {
    return {
      "<Set>": [...value]
        .map((v) => serialise(v))
        .map((v) => JSON.stringify(v) ?? "null")
        .sort()
        .map((s) => JSON.parse(s) as unknown),
    };
  }
  if (React.isValidElement(value)) {
    // Elements are serialised STRUCTURALLY (type + props + children), not as an opaque tag: a
    // `Tile`'s `icon`/`extra` props are elements, and their content is exactly what the user sees.
    const el = value as React.ReactElement<Record<string, unknown>>;
    const out: Record<string, unknown> = { $element: elementName(el) };
    if (el.key != null) out.$key = el.key;
    const props = serialise(el.props ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length > 0) out.$props = props;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => serialise(v));
  if (t === "object") {
    const tag = fixtureTags.get(value as object);
    if (tag) return `<fixture ${tag}>`;
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const s = serialise(src[k]);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 3. Mocked leaves
// ---------------------------------------------------------------------------

type LeafProps = Record<string, unknown>;

/** A stand-in for a leaf component: records its props under the enclosing plugin's key, draws nothing. */
export function makeLeaf(component: string): React.FC<LeafProps> {
  const Leaf: React.FC<LeafProps> = (props) => {
    const key = React.useContext(NodeKeyContext);
    leafCaptures.push({
      key: key ?? `<orphan:${component}>`,
      component,
      props,
    });
    return null;
  };
  Leaf.displayName = `MockLeaf(${component})`;
  return Leaf;
}

/** The three keys `SiteChartsGroup`'s `cardVisible` predicate can be asked about. */
export const COLLAPSE_KEYS = [
  "chart:generation",
  "chart:load",
  "sankey",
] as const;

/**
 * `SiteChartsCard` is the collapse target: the host renders it directly (not through a plugin), so
 * it has no `NodeKeyContext` — it is keyed by the handle it collapsed for. Its `cardVisible` prop is
 * an opaque closure over the collapse-key Set, so the harness PROBES it: the recorded `visibleKeys`
 * is what makes each `chart` card's `collapseKey` contribution visible in the snapshot.
 */
export function makeSiteChartsLeaf(): React.FC<LeafProps> {
  const Leaf: React.FC<LeafProps> = (props) => {
    const visible = props.cardVisible as ((k: string) => boolean) | undefined;
    leafCaptures.push({
      key: `site-charts@${String(props.systemId)}`,
      component: "SiteChartsCard",
      props: {
        ...props,
        cardVisible: undefined,
        visibleKeys: visible
          ? COLLAPSE_KEYS.filter((k) => visible(k))
          : undefined,
      },
    });
    return null;
  };
  Leaf.displayName = "MockLeaf(SiteChartsCard)";
  return Leaf;
}

// ---------------------------------------------------------------------------
// 4. Plugin instrumentation (wrap-and-call-through — the plugins stay under test)
// ---------------------------------------------------------------------------

interface NodePluginLike {
  /** The registry's discriminant (config-v4 Phase 14 stage 7): "tile" | "card". */
  kind: string;
  type: string;
  Render: React.FC<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * Wrap every plugin in the single `CARD_RENDERERS` (components/dashboard/registry.tsx). Replaces the
 * pair `instrumentCardRenderers`/`instrumentTileRenderers`, which existed only because the registry
 * was two maps — the same merge the stage under test performs, applied to the instrumentation.
 *
 * 🛑 The capture KEYS and the `plugin` labels are load-bearing: they are the snapshot's top-level
 * keys and a field of BOTH compared layers, so they are derived from `kind` in a way that reproduces
 * the two old functions EXACTLY (`card:<type>` keyed by node id; `tile:<view>@<systemId>`).
 */
export function instrumentRenderers(
  actual: Record<string, NodePluginLike>,
): Record<string, NodePluginLike> {
  const out: Record<string, NodePluginLike> = {};
  for (const [type, plugin] of Object.entries(actual)) {
    const isTile = plugin.kind === "tile";
    const label = `${isTile ? "tile" : "card"}:${type}`;
    const Real = plugin.Render;
    const Wrapped: React.FC<Record<string, unknown>> = (props) => {
      // A tile's props carry no node id (`V4TileCell` passes only the plugin + systemId), so a tile
      // is keyed by the pair that identifies its cell in the fixture document.
      const key = isTile
        ? `tile:${type}@${String(props.systemId)}`
        : nodeKeyOf(props, `card:${type}:<no-id>`);
      pluginCaptures.push({ key, plugin: label, props });
      return React.createElement(
        NodeKeyContext.Provider,
        { value: key },
        React.createElement(Real, props),
      );
    };
    Wrapped.displayName = `Capture(${label})`;
    out[type] = { ...plugin, Render: Wrapped };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. The fixture world
// ---------------------------------------------------------------------------

/** One frozen instant for every measurement, so nothing in the snapshot moves with the clock. */
export const FIXTURE_TIME = new Date("2026-07-30T04:05:00.000Z");

function pt(
  logicalPath: string,
  value: number,
  metricUnit: string,
  displayName: string,
) {
  return {
    value,
    logicalPath,
    measurementTime: FIXTURE_TIME,
    metricUnit,
    displayName,
  };
}

/**
 * A TEXT point. `LatestPointValue.value` is typed `number`, but `convertValueByMetadata` stores a
 * string for `metricUnit === "text"` and it travels to the browser as one — see `getTextValue` in
 * components/dashboard/tiles/shared.tsx. The fixture has to reproduce the wire, not the type.
 */
function ptText(
  logicalPath: string,
  value: string,
  displayName: string,
): LatestPointValues[string] {
  return {
    value: value as unknown as number,
    logicalPath,
    measurementTime: FIXTURE_TIME,
    metricUnit: "text",
    displayName,
  };
}

/** A `latest` map rich enough that all 10 tile plugins report `isAvailable`. */
export const FIXTURE_LATEST: LatestPointValues = {
  "source.solar/power": pt("source.solar/power", 4200, "W", "Solar"),
  "source.solar.local/power": pt(
    "source.solar.local/power",
    3000,
    "W",
    "Solar Local",
  ),
  "source.solar.remote/power": pt(
    "source.solar.remote/power",
    1200,
    "W",
    "Solar Remote",
  ),
  "bidi.battery/power": pt("bidi.battery/power", -1500, "W", "Battery"),
  "bidi.battery/soc": pt("bidi.battery/soc", 72.5, "%", "Battery SoC"),
  "bidi.grid/power": pt("bidi.grid/power", 800, "W", "Grid"),
  "load/power": pt("load/power", 3500, "W", "Load"),
  "load.hws/temperature": pt("load.hws/temperature", 58, "C", "HWS Temp"),
  "load.hws/power": pt("load.hws/power", 3600, "W", "HWS"),
  "bidi.grid.import/rate": pt("bidi.grid.import/rate", 0.31, "$/kWh", "Import"),
  "ev.battery/soc": pt("ev.battery/soc", 64, "%", "EV SoC"),
  "grid.price/rate": pt("grid.price/rate", 92.5, "$/MWh", "Spot"),
  "grid.emissionsIntensity/intensity": pt(
    "grid.emissionsIntensity/intensity",
    0.55,
    "tCO2e/MWh",
    "Intensity",
  ),
  "grid.renewables/proportion": pt(
    "grid.renewables/proportion",
    41.2,
    "%",
    "Renewables",
  ),
  "grid.demand/power": pt("grid.demand/power", 7200, "MW", "Demand"),
  // The hub-supervised generator's control plane (packages/usher/core/control.ts CONTROL_MANIFEST)
  // plus the one engine register the tile shows. `idle` is the resting state, so the fixture
  // exercises the tile's ordinary appearance rather than a run in progress.
  "source.generator.control.status/state": ptText(
    "source.generator.control.status/state",
    "idle",
    "Control State",
  ),
  "source.generator.control.request/duration": pt(
    "source.generator.control.request/duration",
    0,
    "min",
    "Generator Run Request",
  ),
  "source.generator.mode/state": ptText(
    "source.generator.mode/state",
    "Auto",
    "Control Mode",
  ),
  "source.generator.engine/speed": pt(
    "source.generator.engine/speed",
    0,
    "rpm",
    "Engine Speed",
  ),
};

interface FixtureDevice {
  id: number;
  deviceId: string;
  vendorType: string;
  vendorSiteId: string | null;
  timezoneOffsetMin: number;
  displayTimezone: string | null;
  config?: Record<string, unknown> | null;
}

interface FixturePayload {
  device: FixtureDevice;
  latest: LatestPointValues;
  deviceInfo?: { solarSize?: string; ratings?: string };
}

function payload(
  systemId: number,
  device: Omit<FixtureDevice, "id" | "deviceId">,
  deviceInfo?: { solarSize?: string; ratings?: string },
): FixturePayload {
  const p: FixturePayload = {
    device: { id: systemId, deviceId: `dv_fixture_${systemId}`, ...device },
    latest: FIXTURE_LATEST,
    ...(deviceInfo ? { deviceInfo } : {}),
  };
  tagFixture(p, `data@${systemId}`);
  tagFixture(p.device, `device@${systemId}`);
  return p;
}

/** `/api/data` payloads keyed by the legacy handle the card/tile fetches with. */
export const FIXTURE_DATA: Record<number, FixturePayload> = {
  // Area 1's handle — the whole-area subject most cards read.
  1: payload(
    1,
    {
      vendorType: "selectronic",
      vendorSiteId: "1234",
      timezoneOffsetMin: 600,
      displayTimezone: "Australia/Sydney",
      config: { updateCadenceSeconds: 60 },
    },
    { solarSize: "9 kW", ratings: "7.5kW, 48V" },
  ),
  // Area 2's handle.
  2: payload(2, {
    vendorType: "sigenergy",
    vendorSiteId: "5678",
    timezoneOffsetMin: 570,
    displayTimezone: "Australia/Adelaide",
    config: null,
  }),
  // Device-bound subjects.
  11: payload(11, {
    vendorType: "selectronic",
    vendorSiteId: "1234",
    timezoneOffsetMin: 600,
    displayTimezone: "Australia/Sydney",
    config: { updateCadenceSeconds: 30 },
  }),
  12: payload(12, {
    vendorType: "deepsea",
    vendorSiteId: "gen-1",
    timezoneOffsetMin: 600,
    displayTimezone: "Australia/Sydney",
    config: null,
  }),
  13: payload(13, {
    vendorType: "openelectricity",
    vendorSiteId: "NSW1",
    timezoneOffsetMin: 600,
    displayTimezone: "Australia/Sydney",
    config: null,
  }),
};

tagFixture(FIXTURE_LATEST, "latest");

/** The stand-in for `useAreaDatum` — same shape, no React Query, no modal context. */
export function fakeAreaDatum(systemId: number): {
  data: unknown;
  datum: unknown;
  isLoading: boolean;
  paused: boolean;
} {
  const data = FIXTURE_DATA[systemId] ?? null;
  return { data, datum: data, isLoading: false, paused: false };
}

// ---------------------------------------------------------------------------
// 6. Stable ids + resolver inputs
// ---------------------------------------------------------------------------

const uuid = (n: number): string =>
  `01912e2a-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;

export const AREA_1: AreaId = Area.encode(uuid(1));
export const AREA_2: AreaId = Area.encode(uuid(2));
export const AREA_1_UUID = uuid(1);
export const AREA_2_UUID = uuid(2);

export const DEV_METRICS: DeviceId = Device.encode(uuid(11));
export const DEV_GEN: DeviceId = Device.encode(uuid(12));
export const DEV_OE: DeviceId = Device.encode(uuid(13));
/** Deliberately absent from `deviceById` — exercises the "Device unavailable" branch. */
export const DEV_MISSING: DeviceId = Device.encode(uuid(99));

export const AREAS_BY_ID: Map<string, ReadableArea> = new Map([
  [
    AREA_1 as string,
    {
      id: AREA_1_UUID,
      displayName: "Fixture Area One",
      legacySystemId: 1,
      chartCapable: true,
    },
  ],
  [
    AREA_2 as string,
    {
      id: AREA_2_UUID,
      displayName: "Fixture Area Two",
      legacySystemId: 2,
      chartCapable: false,
    },
  ],
]);

export const DEVICES_BY_ID: Map<string, ResolvedDevice> = new Map([
  [
    DEV_METRICS as string,
    { deviceId: DEV_METRICS, name: "Inverter", systemId: 11 },
  ],
  [DEV_GEN as string, { deviceId: DEV_GEN, name: "Generator", systemId: 12 }],
  [DEV_OE as string, { deviceId: DEV_OE, name: "NSW1", systemId: 13 }],
]);
