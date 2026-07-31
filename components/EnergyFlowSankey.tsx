"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  sankey as d3Sankey,
  SankeyGraph,
  SankeyNode,
  SankeyLink,
} from "d3-sankey";
import { EnergyFlowMatrix } from "@/lib/energy-flow-matrix";
import { formatFlowMagnitude } from "@/lib/energy-formatting";
import NodeTooltip, { PANEL_WIDTH } from "@/components/NodeTooltip";
import LinkTooltip from "@/components/LinkTooltip";

/** How the Sankey lays out storage. "columns" = classic sources→loads bipartite; "battery-middle" =
 *  3-column with the battery relocated to a central STORAGE column (charge in, discharge out). */
export type SankeyLayout = "columns" | "battery-middle";

/** User-configurable Sankey display options (persisted per sankey, see FlowsSettingsMenu). */
export interface SankeyOptions {
  combineSolar: boolean;
  batteryMiddle: boolean;
}

export const DEFAULT_SANKEY_OPTIONS: SankeyOptions = {
  combineSolar: false,
  batteryMiddle: false,
};

/** One value within a tooltip metric: a number spelling with its unit rendered BENEATH it (mirrors a
 *  Sankey node's "58.4" over "kWh"). `unit` is omitted where it's already part of the value ("$2.25",
 *  "80%") or absent. */
export interface SankeyMetricValue {
  value: string;
  unit?: string;
}

/** One tooltip metric: an absolute value plus an optional secondary rate, shown as two columns. */
export interface SankeyMetric {
  primary: SankeyMetricValue;
  secondary?: SankeyMetricValue;
}

/**
 * The hover/tap tooltip payload for one Sankey node — either the FULL 4-metric reduction (interval
 * views: energy/emissions/cost/renewable integrated over the exact period shown) or the LIMITED
 * instantaneous-power-only variant (a focused 1D/7D chart sample, which has no integrals to show).
 */
export type SankeyNodeTooltip = { name: string } & (
  | {
      variant: "full";
      energy: SankeyMetric;
      emissions: SankeyMetric;
      cost: SankeyMetric;
      renewable: SankeyMetric;
      estimatedPct?: number;
    }
  | { variant: "energy"; energy: SankeyMetric }
);

/**
 * Resolves a hovered/tapped node to its tooltip content. Returns `null` when there's nothing to show
 * (feature degrades — no listeners are wasted on a node the caller can't explain). Returns a `{left,
 * right}` pair only for the `bidi.battery` middle node (battery-middle layout): `left` = load-mode
 * (charge/consumed) panel, `right` = source-mode (discharge/supplied) panel — shown SIMULTANEOUSLY.
 */
export type SankeyNodeTooltipResolver = (node: {
  id?: string;
  side?: "source" | "load";
  name: string;
  total: number;
}) =>
  | SankeyNodeTooltip
  | { left: SankeyNodeTooltip; right: SankeyNodeTooltip }
  | null;

function isDualTooltip(
  c: SankeyNodeTooltip | { left: SankeyNodeTooltip; right: SankeyNodeTooltip },
): c is { left: SankeyNodeTooltip; right: SankeyNodeTooltip } {
  return "left" in c && "right" in c;
}

/**
 * The hover tooltip payload for one Sankey LINK (spline). `energy`/`energyUnit` is the flow's energy
 * ("12.3"/"kWh") or instantaneous power ("5.2"/"kW"); the `emissions`/`cost`/`renewable` trio is present
 * only for attributed (kWh) windows (each a fully-formatted string, e.g. "1.2 kg", "$0.45", "80%").
 */
export interface SankeyLinkTooltip {
  energy: string;
  energyUnit: string;
  emissions?: string;
  cost?: string;
  renewable?: string;
}

/**
 * Resolves a hovered link to its tooltip content. Returns `null` when there's nothing to show (no
 * listeners are then wasted). The `source`/`target` carry the node's canonical id (for the per-edge
 * provenance lookup) plus its side/name.
 */
export type SankeyLinkTooltipResolver = (link: {
  source: { id?: string; side?: "source" | "load"; name: string };
  target: { id?: string; side?: "source" | "load"; name: string };
  value: number;
}) => SankeyLinkTooltip | null;

interface EnergyFlowSankeyProps {
  matrix: EnergyFlowMatrix;
  /** Unit shown on node values + link tooltips: cumulative window energy ("kWh") or focused-point power ("kW"). */
  unit?: "kWh" | "kW";
  /** Column layout: classic two-column (default) or battery relocated to a middle STORAGE column. */
  layout?: SankeyLayout;
  width?: number;
  height?: number;
  /** Per-node hover/tap tooltip resolver. Omitted ⇒ no tooltip listeners are attached at all. */
  nodeTooltip?: SankeyNodeTooltipResolver;
  /** Per-link (spline) hover tooltip resolver. Omitted ⇒ links keep the native SVG `<title>` fallback. */
  linkTooltip?: SankeyLinkTooltipResolver;
}

/** Screen-space placement for one tooltip panel. */
interface PanelPlacement {
  side: "left" | "right";
  left: number;
  top: number;
  beakTop: number;
  /** Beak shape: the "diamond" (tall nodes), a "half beak" hugging the node's top/bottom edge (short
   *  nodes, where the diamond would overshoot), or "none" when the panel overlaps its own node.
   *  `beakTop` is interpreted per variant — see NodeTooltip. */
  beakVariant: "diamond" | "half-top" | "half-bottom" | "none";
  /** False during the measure pass (panel mounted off-position, hidden) — see the positioning effect. */
  visible: boolean;
}

interface HoveredNode {
  /** `${side ?? "storage"}:${name}` — identifies the node for hover/tap toggling across re-renders. */
  key: string;
  content:
    | SankeyNodeTooltip
    | { left: SankeyNodeTooltip; right: SankeyNodeTooltip };
  /** The node's SVG-space box at hover time (layout is invalidated on every effect re-run). */
  geomSvg: { x0: number; x1: number; y0: number; y1: number };
  /** Whether the node box is tall enough to render its own title chip — when true the tooltip omits
   *  the (redundant) heading. */
  titleVisibleInNode: boolean;
  /** Which discovered column the node sits in — drives which side(s) the panel(s) appear on. */
  columnPos: "left" | "right" | "interior";
  /** The node's vertical position within its column — "top"/"bottom" anchor the panel to that edge of
   *  the node; "middle" (and lone nodes) centre it. */
  vertPos: "top" | "bottom" | "middle";
  /** The node's fill colour — the tooltip renders as a coloured "card" of the node (see NodeTooltip).
   *  For the battery-middle dual `{left,right}` case it's the single battery node's colour, shared by
   *  both panels. */
  color: string;
}

/** A hovered link's tooltip content + its spline-midpoint placement (viewport coords). */
interface HoveredLink {
  /** `${source.name}→${target.name}` — identifies the link for hover toggling across re-renders. */
  key: string;
  content: SankeyLinkTooltip;
  /** The link's SOURCE colour — the tooltip card's background (see LinkTooltip). */
  color: string;
  /** Viewport coords of the spline midpoint; the card centres on this point. */
  left: number;
  top: number;
}

interface SankeyNodeData {
  /** Canonical flow path (e.g. "source.solar", "source.battery"); used to identify the battery. */
  id?: string;
  /** Which column the node was built for; drives side-dependent vertical ordering. Robust across
   *  render paths (id is mangled on the client/hover path), since it's set from which array the
   *  node came from (matrix.sources vs matrix.loads). */
  side?: "source" | "load";
  name: string;
  color: string;
  /** This node's own total energy (kWh) or power (kW) — carried so the draw loop needn't reverse-map
   *  filtered→original indices. NOT named `value`: d3-sankey overwrites `node.value` during layout. */
  total: number;
}

interface SankeyLinkData {
  source: number;
  target: number;
  value: number;
}

// Helper function to shorten labels
function shortenLabel(label: string): string {
  const lower = label.toLowerCase();

  if (lower.includes("battery discharge")) return "Battery";
  if (lower.includes("battery charge")) return "Battery";
  if (lower.includes("battery")) return "Battery";
  if (lower.includes("grid import")) return "Grid";
  if (lower.includes("grid export")) return "Grid";
  if (lower.includes("grid")) return "Grid";
  if (lower.includes("other loads")) return "Other";

  return label;
}

// Colors now come from the matrix nodes (energy-flow-matrix.ts uses centralized colors)

const LINK_MIN = 0.01; // ignore negligible flows (kWh/kW)

/** Ribbon opacities: the resting value, and the node-hover emphasis pair (connected strong, others
 *  weak). Tunable — "strong contrast" per the design. */
const LINK_BASE_OPACITY = 0.6;
const LINK_EMPHASIS_ON = 0.85;
const LINK_EMPHASIS_OFF = 0.15;

/** Min node box height (px) for the node to render its own title chip (see the draw loop). Below this
 *  the node has no title, so the hover tooltip carries the heading instead. */
const MIN_HEIGHT_FOR_LABEL = 28;
/** The diamond beak's px size. Nodes shorter than this get the "half beak" (see NodeTooltip) so the
 *  diamond doesn't overshoot the node. */
const BEAK_SIZE = 12;
/** Half the diamond beak's VERTICAL span — it's a BEAK_SIZE square rotated 45°, so it stands
 *  BEAK_SIZE·√2 ≈ 17px tall. Used to keep the whole diamond (not just its centre) on the node. */
const BEAK_HALF_SPAN = Math.round((BEAK_SIZE * Math.SQRT2) / 2);
/** The half beak's px size (width & height) — keep in sync with NodeTooltip's half-beak dimensions. */
const HALF_BEAK_SIZE = 7;
/** Minimum stroke width (px) of a ribbon's transparent touch hit target — a thin spline is otherwise
 *  untappable. Roughly a fingertip's worth of slop either side of the ribbon. */
const HIT_STROKE_MIN = 22;

/** Diagram margins (px). The top/bottom pair also bounds the band tooltips are clamped into, so it's
 *  shared between the draw effect's `extent` and the placement effects rather than re-typed. */
const MARGIN_TOP = 35;
const MARGIN_BOTTOM = 20;

/** Laid-out diagram geometry the tooltip placement needs, captured by the draw effect. */
interface SankeyGeom {
  /** SVG-space top of the TOPMOST node and bottom of the BOTTOMMOST node — the vertical band every
   *  tooltip is clamped into. Read off the laid-out nodes rather than the margins so a single-node
   *  column (which the reflow centres instead of stretching) is honoured. */
  bandTop: number;
  bandBottom: number;
  /** Each column's SVG x-range, left→right — a panel with no room beside its node is centred in the
   *  gap between its column and the neighbouring one. */
  columns: { x0: number; x1: number }[];
}

/** Classic two-column graph: every source above threshold → a left node, every load → a right node. */
function buildColumnsGraph(
  matrix: EnergyFlowMatrix,
  minEnergy: number,
): { nodes: SankeyNodeData[]; links: SankeyLinkData[] } {
  const nodes: SankeyNodeData[] = [];
  const links: SankeyLinkData[] = [];

  const srcNode = new Map<number, number>(); // matrix source idx → node idx
  matrix.sources.forEach((s, i) => {
    if (matrix.sourceTotals[i] < minEnergy) return;
    srcNode.set(i, nodes.length);
    nodes.push({
      id: s.id,
      side: "source",
      name: shortenLabel(s.label),
      color: s.color,
      total: matrix.sourceTotals[i],
    });
  });

  const loadNode = new Map<number, number>(); // matrix load idx → node idx
  matrix.loads.forEach((l, j) => {
    if (matrix.loadTotals[j] < minEnergy) return;
    loadNode.set(j, nodes.length);
    nodes.push({
      id: l.id,
      side: "load",
      name: shortenLabel(l.label),
      color: l.color,
      total: matrix.loadTotals[j],
    });
  });

  for (const [s, sn] of srcNode) {
    for (const [l, ln] of loadNode) {
      const v = matrix.matrix[s][l];
      if (v > LINK_MIN) links.push({ source: sn, target: ln, value: v });
    }
  }
  return { nodes, links };
}

/**
 * Three-column graph: the battery is relocated to a central STORAGE node. Non-battery sources flow into
 * the battery (charge, `matrix[s][load.battery]`) or directly to loads (`matrix[s][l]`); the battery flows
 * out to loads (discharge, `matrix[source.battery][l]`). d3-sankey's default `justify` alignment then
 * places the battery (which has BOTH in- and out-links) in the middle column and every load (a sink, no
 * out-links) in the rightmost — including loads fed only by a direct source link. If the battery only
 * charges OR only discharges in-window it naturally collapses back to two columns on the acting side.
 */
function buildBatteryMiddleGraph(
  matrix: EnergyFlowMatrix,
  minEnergy: number,
  bs: number, // source idx of source.battery (discharge), or -1
  bl: number, // load idx of load.battery (charge), or -1
): { nodes: SankeyNodeData[]; links: SankeyLinkData[] } {
  const nodes: SankeyNodeData[] = [];
  const links: SankeyLinkData[] = [];

  const leftNode = new Map<number, number>(); // non-battery source idx → node idx
  matrix.sources.forEach((s, i) => {
    if (i === bs || matrix.sourceTotals[i] < minEnergy) return;
    leftNode.set(i, nodes.length);
    nodes.push({
      id: s.id,
      side: "source",
      name: shortenLabel(s.label),
      color: s.color,
      total: matrix.sourceTotals[i],
    });
  });

  // Middle battery node. Sized to max(charge in, discharge out) — inflow ≠ outflow across the window
  // (round-trip loss / SoC drift) is expected; d3-sankey sizes the box to the larger side either way.
  const chargeTotal = bl >= 0 ? matrix.loadTotals[bl] : 0;
  const dischargeTotal = bs >= 0 ? matrix.sourceTotals[bs] : 0;
  const batteryColor =
    (bs >= 0 ? matrix.sources[bs].color : undefined) ??
    (bl >= 0 ? matrix.loads[bl].color : undefined) ??
    "#22c55e";
  const batteryIdx = nodes.length;
  nodes.push({
    id: "bidi.battery",
    name: "Battery",
    color: batteryColor,
    total: Math.max(chargeTotal, dischargeTotal),
  });

  const rightNode = new Map<number, number>(); // non-battery load idx → node idx
  matrix.loads.forEach((l, j) => {
    if (j === bl || matrix.loadTotals[j] < minEnergy) return;
    rightNode.set(j, nodes.length);
    nodes.push({
      id: l.id,
      side: "load",
      name: shortenLabel(l.label),
      color: l.color,
      total: matrix.loadTotals[j],
    });
  });

  for (const [s, sn] of leftNode) {
    for (const [l, ln] of rightNode) {
      const v = matrix.matrix[s][l];
      if (v > LINK_MIN) links.push({ source: sn, target: ln, value: v }); // direct
    }
    if (bl >= 0) {
      const charge = matrix.matrix[s][bl];
      if (charge > LINK_MIN)
        links.push({ source: sn, target: batteryIdx, value: charge });
    }
  }
  if (bs >= 0) {
    for (const [l, ln] of rightNode) {
      const discharge = matrix.matrix[bs][l];
      if (discharge > LINK_MIN)
        links.push({ source: batteryIdx, target: ln, value: discharge });
    }
  }
  return { nodes, links };
}

/**
 * Build the d3-sankey node/link model for a layout. `battery-middle` needs a battery present and above
 * the display threshold on at least one side; otherwise it degrades to the classic two-column graph.
 */
function buildFlowGraph(
  matrix: EnergyFlowMatrix,
  layout: SankeyLayout,
  minEnergy: number,
): { nodes: SankeyNodeData[]; links: SankeyLinkData[] } {
  if (layout === "battery-middle") {
    const bs = matrix.sources.findIndex((n) => n.id === "source.battery");
    const bl = matrix.loads.findIndex((n) => n.id === "load.battery");
    const hasBattery =
      (bs >= 0 && matrix.sourceTotals[bs] >= minEnergy) ||
      (bl >= 0 && matrix.loadTotals[bl] >= minEnergy);
    if (hasBattery) return buildBatteryMiddleGraph(matrix, minEnergy, bs, bl);
  }
  return buildColumnsGraph(matrix, minEnergy);
}

/**
 * Energy Flow Sankey Diagram
 *
 * Visualizes energy flow from sources (left) to loads (right) with:
 * - Color gradients from source → target
 * - Proportional band widths
 * - Interactive tooltips
 */
export default function EnergyFlowSankey({
  matrix,
  unit = "kWh",
  layout = "columns",
  width = 600,
  height = 680,
  nodeTooltip,
  linkTooltip,
}: EnergyFlowSankeyProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [actualWidth, setActualWidth] = useState(width);
  const [hovered, setHovered] = useState<HoveredNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<HoveredLink | null>(null);
  const [placementL, setPlacementL] = useState<PanelPlacement | null>(null);
  const [placementR, setPlacementR] = useState<PanelPlacement | null>(null);
  const panelRefL = useRef<HTMLDivElement>(null);
  const panelRefR = useRef<HTMLDivElement>(null);
  const linkPanelRef = useRef<HTMLDivElement>(null);
  /** The hovered link card's band-clamped viewport y (its CENTRE — the card translates ‑50%). `null`
   *  while the measure pass runs, during which the card is mounted-but-hidden. */
  const [linkTop, setLinkTop] = useState<number | null>(null);
  /** Laid-out geometry from the most recent draw — a ref, not state: it's written by the draw effect and
   *  read by the placement effects, which always run after it on any layout change. */
  const geomRef = useRef<SankeyGeom | null>(null);
  // Mirrors of the two open tooltips, written during render so the draw effect (which does NOT depend on
  // them — depending on them would rebuild the diagram on every hover) can see what was open when it
  // re-runs and carry it across the rebuild. See the restore at the end of that effect.
  const hoveredRef = useRef<HoveredNode | null>(null);
  const hoveredLinkRef = useRef<HoveredLink | null>(null);
  hoveredRef.current = hovered;
  hoveredLinkRef.current = hoveredLink;
  // The resolver is read through a ref inside the (expensive, `svg.innerHTML = ""`-rebuilding) draw
  // effect below, so a resolver identity change alone (the parent re-creating its closure — e.g. a
  // sankeyOptions toggle that doesn't change `matrix`/`unit`/`layout`) never forces a full diagram
  // rebuild; only the values actually in the draw effect's dependency array do that. The listeners
  // attached during a rebuild always call the LATEST resolver via this ref.
  const nodeTooltipRef = useRef(nodeTooltip);
  useEffect(() => {
    nodeTooltipRef.current = nodeTooltip;
  }, [nodeTooltip]);
  // Read through a ref for the same reason as `nodeTooltipRef` — a link-resolver identity change alone
  // must not force the expensive `svg.innerHTML = ""` rebuild below.
  const linkTooltipRef = useRef(linkTooltip);
  useEffect(() => {
    linkTooltipRef.current = linkTooltip;
  }, [linkTooltip]);

  // Detect mobile screen size and container width
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 640; // Tailwind's sm breakpoint
      setIsMobile(mobile);

      // On mobile, use full container width
      if (mobile && containerRef.current) {
        const containerWidth = containerRef.current.offsetWidth;
        setActualWidth(containerWidth);
      } else {
        setActualWidth(width);
      }
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, [width]);

  useEffect(() => {
    if (!svgRef.current) return;

    // Clear previous render
    const svg = svgRef.current;
    svg.innerHTML = "";

    geomRef.current = null;

    // An open tooltip belongs to the PREVIOUS render — its geometry is stale and its listeners were just
    // GC'd with the old SVG. Rather than dismiss it (a live window refetches every minute or so, and a
    // panel vanishing mid-read is maddening), remember which node/link it was on and re-resolve it
    // against the NEW layout once that's built: `restoreNode`/`restoreLink` are set by the draw loops
    // below when they meet the matching key, and applied at the very end of this effect. A node or link
    // that's no longer in the diagram simply doesn't match, and the tooltip closes as before.
    const prevNodeKey = hoveredRef.current?.key ?? null;
    const prevLinkKey = hoveredLinkRef.current?.key ?? null;
    // One holder rather than three `let`s: the draw loops assign inside callbacks, which TS's flow
    // analysis doesn't track for a plain `let` (it would still read as `null` at the restore below).
    const restore: {
      node: (() => HoveredNode | null) | null;
      link: (() => HoveredLink | null) | null;
      emphasis: (() => void) | null;
    } = { node: null, link: null, emphasis: null };

    // Filter out sources and loads with < 0.1 kWh
    const MIN_ENERGY = 0.1;

    // Build the node/link model for the chosen layout. Each node carries its own `total`, so the draw
    // loop below reads it directly (no filtered→original index reverse-mapping). Columns are discovered
    // from the laid-out x-positions, so this supports 2 (columns) or 3 (battery-middle) columns.
    const { nodes, links } = buildFlowGraph(matrix, layout, MIN_ENERGY);

    // If there are no nodes or links, show a message instead of rendering
    if (nodes.length === 0 || links.length === 0) {
      setHovered(null);
      setHoveredLink(null);
      const noDataText = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      noDataText.setAttribute("x", String(actualWidth / 2));
      noDataText.setAttribute("y", String(height / 2));
      noDataText.setAttribute("text-anchor", "middle");
      noDataText.setAttribute("fill", "#9CA3AF");
      noDataText.setAttribute("font-size", "14");
      noDataText.textContent = "No energy flow data for this period";
      svg.appendChild(noDataText);
      return;
    }

    // Configure sankey layout with responsive margins and node width. Battery-middle adds a third
    // column, so shrink the nodes a touch on mobile to leave room for the ribbons.
    const nodeWidth =
      layout === "battery-middle" && isMobile ? 72 : isMobile ? 86 : 96;
    const margin = isMobile
      ? { left: 0, right: 0, top: MARGIN_TOP, bottom: MARGIN_BOTTOM } // No side margins on mobile
      : { left: 60, right: 60, top: MARGIN_TOP, bottom: MARGIN_BOTTOM };

    // Custom node sorting to control vertical order.
    // SOURCES column (top→bottom): Solar, Other, House, Battery, Grid.
    // LOADS column: Battery is lifted to the TOP (avoids the central ribbon crossover), the rest
    // keep the same relative order. Side comes from the node's build-time `side` tag, not its id
    // (id is mangled on the client/hover render path).
    const getNodeOrder = (node: any): number => {
      // Access the name from the node's data
      const name = node.name || "";
      const lower = name.toLowerCase();

      if (lower.includes("solar")) return 0;
      if (lower.includes("house")) return 2;
      // Load-side battery sits at the very top; source-side battery stays low.
      if (lower.includes("battery")) return node.side === "load" ? -1 : 3;
      if (lower.includes("grid")) return 4;
      return 1; // Other loads between solar and house
    };

    const sankey = d3Sankey<SankeyNodeData, SankeyLinkData>()
      .nodeId((d: any) => d.index)
      .nodeWidth(nodeWidth)
      .nodePadding(15)
      .nodeSort((a: any, b: any) => {
        const orderA = getNodeOrder(a);
        const orderB = getNodeOrder(b);
        return orderA - orderB;
      })
      .extent([
        [margin.left, margin.top],
        [actualWidth - margin.right, height - margin.bottom],
      ]);

    // Generate the sankey diagram
    const graph: SankeyGraph<SankeyNodeData, SankeyLinkData> = sankey({
      nodes: nodes.map((d, i) => ({ ...d, index: i })) as any,
      links: links.map((d) => ({ ...d })) as any,
    });

    // Align the top and bottom of both columns to the same vertical band.
    //
    // d3-sankey lays out and centers each column independently, so columns with
    // different node counts / total values end up with mismatched top and bottom
    // edges. Re-flow each column to fill the full extent [margin.top, bottom],
    // keeping each node's d3-computed height and distributing the gaps evenly.
    const bandTop = margin.top;
    const bandBottom = height - margin.bottom;
    const availableHeight = bandBottom - bandTop;

    // Track how much each node was shifted (for updating links afterwards)
    const nodeShifts = new Map<any, number>();

    const reflowColumn = (columnNodes: any[]) => {
      if (columnNodes.length === 0) return;

      // Sort by current y0 to get true top-to-bottom order (the nodes array
      // order need not match vertical order once nodeSort has run).
      const ordered = [...columnNodes].sort((a, b) => a.y0 - b.y0);

      const sumNodeHeights = ordered.reduce(
        (sum, node) => sum + (node.y1 - node.y0),
        0,
      );

      if (ordered.length === 1) {
        // A single node can't span both edges; center it in the band instead.
        const node = ordered[0];
        const nodeHeight = node.y1 - node.y0;
        const newY0 = bandTop + (availableHeight - nodeHeight) / 2;
        nodeShifts.set(node, newY0 - node.y0);
        node.y0 = newY0;
        node.y1 = newY0 + nodeHeight;
        return;
      }

      const gap = (availableHeight - sumNodeHeights) / (ordered.length - 1);

      let y = bandTop;
      for (const node of ordered) {
        const nodeHeight = node.y1 - node.y0;
        nodeShifts.set(node, y - node.y0);
        node.y0 = y;
        node.y1 = y + nodeHeight;
        y = node.y1 + gap;
      }
    };

    // Reflow every column, discovered from the laid-out x-positions (d3-sankey assigns each node's x0
    // once and never moves it). Grouping by x0 handles 2 (columns) or 3 (battery-middle) columns
    // uniformly; in two-column mode these are the same two groups as before → pixel-identical.
    const columnsByX = new Map<number, any[]>();
    for (const node of graph.nodes as any[]) {
      const key = Math.round(node.x0);
      const group = columnsByX.get(key);
      if (group) group.push(node);
      else columnsByX.set(key, [node]);
    }
    for (const columnNodes of columnsByX.values()) reflowColumn(columnNodes);

    // Discovered column x-positions, hoisted here (was computed later, near the header draw) so the
    // node draw loop below can classify each node's column for the tooltip resolver.
    const columnXs = [...columnsByX.keys()].sort((a, b) => a - b);
    const minColumnX = columnXs[0];
    const maxColumnX = columnXs[columnXs.length - 1];

    // Publish the laid-out geometry for the tooltip placement effects below (the node band + the column
    // x-ranges). Every node's y is final by now — the bidirectional restack below moves link endpoints,
    // never node boxes.
    geomRef.current = {
      bandTop: Math.min(...(graph.nodes as any[]).map((n) => n.y0)),
      bandBottom: Math.max(...(graph.nodes as any[]).map((n) => n.y1)),
      columns: columnXs.map((x) => {
        const n = (columnsByX.get(x) ?? [])[0];
        return { x0: n.x0, x1: n.x1 };
      }),
    };

    // Update link coordinates to match the shifted nodes. Each node moves
    // rigidly, so a link's within-node offset is preserved by shifting its
    // endpoints by the same delta as the node they attach to.
    graph.links.forEach((link: any) => {
      const sourceShift = nodeShifts.get(link.source);
      if (sourceShift !== undefined) {
        link.y0 += sourceShift;
      }
      const targetShift = nodeShifts.get(link.target);
      if (targetShift !== undefined) {
        link.y1 += targetShift;
      }
    });

    // Re-stack the link endpoints of any BIDIRECTIONAL node — one with BOTH incoming and outgoing
    // links, i.e. the battery-middle STORAGE node (in classic two-column mode no node has both, so
    // this loop is a no-op there → pixel-identical). d3-sankey's computeLinkBreadths stacks each side
    // independently from node.y0 (the top), and the node height is max(Σ charge, Σ discharge)·ky, so
    // the LIGHTER side (charge ≠ discharge over any real window) fills only the top of its edge and
    // leaves a lopsided gap at the bottom — the ribbons look like they attach to the node's interior
    // rather than hugging its left/right edges. Restack each side to span the full node edge: pin the
    // top ribbon to node.y0 and the bottom ribbon to node.y1, distributing any others with equal gaps
    // between them (the heavier side's Σ widths ≈ H so its gap ≈ 0 → it stays contiguous as before).
    // Widths and top-to-bottom order (d3's anti-crossing order) are preserved.
    for (const node of graph.nodes as any[]) {
      if (!node.sourceLinks.length || !node.targetLinks.length) continue;
      const nodeHeight = node.y1 - node.y0;
      const restackSide = (sideLinks: any[], key: "y0" | "y1") => {
        const widthSum = sideLinks.reduce((sum, l) => sum + l.width, 0);
        if (sideLinks.length === 1) {
          // A single ribbon has no "between" gap to distribute — centre it on the edge.
          sideLinks[0][key] = node.y0 + nodeHeight / 2;
          return;
        }
        const gap = (nodeHeight - widthSum) / (sideLinks.length - 1);
        let y = node.y0;
        for (const l of sideLinks) {
          l[key] = y + l.width / 2;
          y += l.width + gap;
        }
      };
      // targetLinks attach to the LEFT edge (their y1); sourceLinks to the RIGHT edge (their y0).
      restackSide(
        [...node.targetLinks].sort((a: any, b: any) => a.y1 - b.y1),
        "y1",
      );
      restackSide(
        [...node.sourceLinks].sort((a: any, b: any) => a.y0 - b.y0),
        "y0",
      );
    }

    // Create SVG container
    const svgElement = svg as any;

    // Border radius for node rectangles - links extend by this amount to fill gaps
    const nodeRadius = 4;

    // Add gradient definitions
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");

    graph.links.forEach((link: any, i: number) => {
      const gradient = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "linearGradient",
      );
      gradient.setAttribute("id", `gradient-${i}`);
      gradient.setAttribute("gradientUnits", "userSpaceOnUse");
      // Use extended coordinates to match path (extend INTO boxes)
      gradient.setAttribute("x1", String(link.source.x1 - nodeRadius));
      gradient.setAttribute(
        "y1",
        String(link.source.y0 + (link.source.y1 - link.source.y0) / 2),
      );
      gradient.setAttribute("x2", String(link.target.x0 + nodeRadius));
      gradient.setAttribute(
        "y2",
        String(link.target.y0 + (link.target.y1 - link.target.y0) / 2),
      );

      const stop1 = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "stop",
      );
      stop1.setAttribute("offset", "0%");
      stop1.setAttribute("stop-color", link.source.color);
      stop1.setAttribute("stop-opacity", "0.6");

      const stop2 = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "stop",
      );
      stop2.setAttribute("offset", "100%");
      stop2.setAttribute("stop-color", link.target.color);
      stop2.setAttribute("stop-opacity", "0.6");

      gradient.appendChild(stop1);
      gradient.appendChild(stop2);
      defs.appendChild(gradient);
    });

    svgElement.appendChild(defs);

    // Every ribbon's <path> + its link datum, collected so hovering a node OR a spline can emphasise the
    // relevant ribbon(s) and fade the rest (`link.source`/`link.target` are node refs after layout).
    const linkEls: { path: SVGPathElement; link: any }[] = [];
    // Touch-only transparent hit twins of the ribbons, appended after all of them (see below).
    const hitEls: SVGPathElement[] = [];

    // Hover emphasis (shared by node + link hover): strengthen the relevant ribbon(s), fade the rest,
    // then restore the base — opacity-only, imperative (mirrors the imperative draw). `emphasizeForNode`
    // brightens every ribbon touching the node; `emphasizeForLink` brightens just the one hovered ribbon.
    const emphasizeForNode = (node: any) => {
      for (const { path, link } of linkEls) {
        const connected = link.source === node || link.target === node;
        path.setAttribute(
          "opacity",
          String(connected ? LINK_EMPHASIS_ON : LINK_EMPHASIS_OFF),
        );
      }
    };
    const emphasizeForLink = (hoveredLinkDatum: any) => {
      for (const { path, link } of linkEls) {
        path.setAttribute(
          "opacity",
          String(
            link === hoveredLinkDatum ? LINK_EMPHASIS_ON : LINK_EMPHASIS_OFF,
          ),
        );
      }
    };
    const resetEmphasis = () => {
      for (const { path } of linkEls)
        path.setAttribute("opacity", String(LINK_BASE_OPACITY));
    };

    // Draw links with gradients (extended to overlap with rounded rect corners)
    graph.links.forEach((link: any, i: number) => {
      // Create extended link coordinates to fill gap from rounded corners (extend INTO boxes)
      const extendedLink = {
        ...link,
        source: { ...link.source, x1: link.source.x1 - nodeRadius },
        target: { ...link.target, x0: link.target.x0 + nodeRadius },
      };

      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      // Spline path: a single SMOOTH cubic whose control points sit further apart horizontally than
      // d3's default (which puts them at the horizontal midpoint). Pushing them out keeps the tangent
      // horizontal LONGER at each node before the curve rises, so a steep spline (e.g. battery
      // discharge to a far-above load) leaves the RIGHT edge horizontally and only rises once it's
      // clear of the node — instead of its top boundary riding up over the node's TOP edge at the
      // corner. No straight segments, so it stays a smooth ribbon. Near-horizontal splines are
      // visually unchanged.
      const sx = extendedLink.source.x1;
      const sy = link.y0;
      const tx = extendedLink.target.x0;
      const ty = link.y1;
      const hGap = tx - sx;
      const hold = hGap * 0.66; // horizontal control-point offset (0.5 = d3 default)
      path.setAttribute(
        "d",
        `M${sx},${sy}C${sx + hold},${sy} ${tx - hold},${ty} ${tx},${ty}`,
      );
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", `url(#gradient-${i})`);
      path.setAttribute("stroke-width", String(Math.max(1, link.width)));
      path.setAttribute("opacity", String(LINK_BASE_OPACITY));
      path.setAttribute("class", "sankey-link");

      // Hover emphasis: strengthen this spline, fade the rest — the SAME opacity settings as node hover.
      // Desktop only (touch has no reliable hover; a tap could leave the chart stuck dimmed).
      if (!isMobile) {
        path.addEventListener("mouseenter", () => emphasizeForLink(link));
        path.addEventListener("mouseleave", resetEmphasis);
      }

      // Link (spline) tooltip. With a resolver, the ugly native SVG <title> is replaced by the pretty
      // LinkTooltip centred on the spline midpoint — desktop on hover, touch on tap (the same tap-toggle
      // the nodes use). Without a resolver, keep the native <title> fallback.
      if (linkTooltipRef.current) {
        const linkKey = `${link.source.name}→${link.target.name}`;
        const resolve = (): HoveredLink | null => {
          const content = linkTooltipRef.current?.({
            source: {
              id: link.source.id,
              side: link.source.side,
              name: link.source.name,
            },
            target: {
              id: link.target.id,
              side: link.target.side,
              name: link.target.name,
            },
            value: link.value,
          });
          const svgEl = svgRef.current;
          if (!content || !svgEl) return null;
          const r = svgEl.getBoundingClientRect();
          const sx = r.width / actualWidth;
          const sy = r.height / height;
          // The spline midpoint: nodeRadius extension cancels in x, and the spline's cubic passes
          // through the endpoint-average y at its horizontal centre (t=0.5).
          const xMid = (link.source.x1 + link.target.x0) / 2;
          const yMid = (link.y0 + link.y1) / 2;
          return {
            key: linkKey,
            content,
            color: link.source.color,
            left: r.left + xMid * sx,
            top: r.top + yMid * sy,
          };
        };
        if (isMobile) {
          // A 1px-wide ribbon is an impossible tap target, so the listener goes on a transparent
          // stroke-only twin (appended above every ribbon, below the nodes — see `hitEls`) that widens
          // the hit area to HIT_STROKE_MIN. Tapping a spline dismisses any open node panel, so the two
          // tooltips can't stack up on a small screen.
          const hit = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          hit.setAttribute("d", path.getAttribute("d")!);
          hit.setAttribute("fill", "none");
          hit.setAttribute("stroke", "transparent");
          hit.setAttribute(
            "stroke-width",
            String(Math.max(HIT_STROKE_MIN, link.width)),
          );
          hit.setAttribute("pointer-events", "stroke");
          hit.setAttribute("class", "sankey-link-hit");
          hit.style.cursor = "pointer";
          hit.addEventListener("click", (e) => {
            e.stopPropagation();
            setHovered(null);
            setHoveredLink((h) => (h?.key === linkKey ? null : resolve()));
          });
          hitEls.push(hit);
        } else {
          path.addEventListener("mouseenter", () => {
            const next = resolve();
            if (next) setHoveredLink(next);
          });
          path.addEventListener("mouseleave", () => {
            setHoveredLink((h) => (h?.key === linkKey ? null : h));
          });
        }
        // The ribbon whose tooltip was open before the rebuild — carry it over (see the top of this
        // effect); `resolve` recomputes the midpoint from this render's geometry.
        if (linkKey === prevLinkKey) {
          restore.link = resolve;
          if (!isMobile) restore.emphasis = () => emphasizeForLink(link);
        }
      } else {
        const title = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "title",
        );
        title.textContent = `${link.source.name} → ${link.target.name}: ${formatFlowMagnitude(link.value)} ${unit}`;
        path.appendChild(title);
      }

      linkEls.push({ path, link });
      svgElement.appendChild(path);
    });

    // Touch hit targets go on top of every ribbon (so a thin spline isn't shadowed by a fat one drawn
    // later) but before the nodes, which are appended below and stay the topmost hit target.
    for (const hit of hitEls) svgElement.appendChild(hit);

    // Percentage denominator: total energy entering the leftmost column. In two-column mode this is the
    // sum of source totals (unchanged from before); in battery-middle it is external generation (the
    // battery sits in the middle column, so it's excluded — an intentional "share of generation" reading).
    const leftmostX = Math.min(...columnsByX.keys());
    const leftColumnTotal = (columnsByX.get(leftmostX) ?? []).reduce(
      (sum, n: any) => sum + (n.total ?? 0),
      0,
    );

    // Draw nodes with labels inside. Each node carries its own `total` (set in buildFlowGraph), so no
    // filtered→original index reverse-mapping is needed.
    graph.nodes.forEach((node: any) => {
      const totalEnergy = node.total ?? 0;
      const percentage =
        leftColumnTotal > 0
          ? ((totalEnergy / leftColumnTotal) * 100).toFixed(0)
          : "0";

      // Draw rectangle
      const rect = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      rect.setAttribute("x", String(node.x0));
      rect.setAttribute("y", String(node.y0));
      rect.setAttribute("width", String(node.x1 - node.x0));
      rect.setAttribute("height", String(node.y1 - node.y0));
      rect.setAttribute("fill", node.color);
      rect.setAttribute("stroke", "none");
      rect.setAttribute("rx", "4");
      rect.setAttribute("class", "sankey-node");
      svgElement.appendChild(rect);

      // The node's HIT box: its own rectangle grown vertically to the MIDPOINT of the gap to the node
      // above and below (the band edge for the outermost, which the reflow already pins there). A
      // ribbon-thin node — a 2px sliver of grid export — is otherwise impossible to hover or tap. Every
      // node gets the same rule, so the target grows with the gap instead of snapping at some arbitrary
      // thinness threshold, and hovering "just off" a node still reads as that node. It keeps exactly
      // the node's x-range, where no ribbon runs (ribbons live strictly BETWEEN columns), so a fat hit
      // box can never steal a spline's hover. All interaction hangs off this rect; the visible one is
      // painted underneath and never receives a pointer event.
      const colNodes: any[] = [
        ...(columnsByX.get(Math.round(node.x0)) ?? []),
      ].sort((a, b) => a.y0 - b.y0);
      const idx = colNodes.indexOf(node);
      const gapAbove = idx > 0 ? node.y0 - colNodes[idx - 1].y1 : 0;
      const gapBelow =
        idx >= 0 && idx < colNodes.length - 1
          ? colNodes[idx + 1].y0 - node.y1
          : 0;
      const hitY0 = node.y0 - gapAbove / 2;
      const hitY1 = node.y1 + gapBelow / 2;
      const hit = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      hit.setAttribute("x", String(node.x0));
      hit.setAttribute("y", String(hitY0));
      hit.setAttribute("width", String(node.x1 - node.x0));
      hit.setAttribute("height", String(hitY1 - hitY0));
      hit.setAttribute("fill", "transparent");
      hit.setAttribute("pointer-events", "all");
      hit.setAttribute("class", "sankey-node-hit");
      svgElement.appendChild(hit);

      // Node-hover spline emphasis (desktop). Independent of the tooltip resolver so it works on any
      // diagram (incl. the /test-sankey page). Hover the node → its ribbons strengthen, the rest fade.
      if (!isMobile) {
        hit.addEventListener("mouseenter", () => emphasizeForNode(node));
        hit.addEventListener("mouseleave", resetEmphasis);
      }

      // Node hover/tap tooltip. `nodeTooltip` absent ⇒ no listeners (feature degrades to the plain
      // diagram). Desktop: hover; mobile: tap-toggle (no hover — touch doesn't reliably fire
      // mouseenter/mouseleave). Reads `nodeTooltipRef` (not the `nodeTooltip` closure variable) so a
      // resolver-identity-only parent re-render never needs to rebuild the whole diagram to keep the
      // tooltip content fresh (see the ref's own comment above).
      if (nodeTooltipRef.current) {
        hit.style.cursor = "pointer";
        const nodeKey = `${node.side ?? "storage"}:${node.name}`;
        const columnPos: "left" | "right" | "interior" =
          Math.round(node.x0) === minColumnX
            ? "left"
            : Math.round(node.x0) === maxColumnX
              ? "right"
              : "interior";
        // Topmost/bottommost within the node's column (reflow fills each column edge-to-edge, so the
        // top node's y0 is the column min and the bottom node's y1 the column max). A lone node stays
        // "middle" — there's no other node to be above/below, so it just centres.
        const vertPos: "top" | "bottom" | "middle" =
          colNodes.length < 2
            ? "middle"
            : idx === 0
              ? "top"
              : idx === colNodes.length - 1
                ? "bottom"
                : "middle";
        const resolve = (): HoveredNode | null => {
          const content = nodeTooltipRef.current?.({
            id: node.id,
            side: node.side,
            name: node.name,
            total: node.total ?? 0,
          });
          if (!content) return null;
          return {
            key: nodeKey,
            content,
            geomSvg: { x0: node.x0, x1: node.x1, y0: node.y0, y1: node.y1 },
            titleVisibleInNode: node.y1 - node.y0 >= MIN_HEIGHT_FOR_LABEL,
            columnPos,
            vertPos,
            color: node.color,
          };
        };
        if (isMobile) {
          hit.addEventListener("click", (e) => {
            e.stopPropagation();
            setHoveredLink(null); // never both at once on a small screen
            setHovered((h) => (h?.key === nodeKey ? null : resolve()));
          });
        } else {
          hit.addEventListener("mouseenter", () => setHovered(resolve()));
          hit.addEventListener("mouseleave", () =>
            setHovered((h) => (h?.key === nodeKey ? null : h)),
          );
        }
        // This is the node whose tooltip was open before the rebuild — carry it over (see the top of
        // this effect). The node loop runs after the link loop, so a node's emphasis wins over a link's.
        if (nodeKey === prevNodeKey) {
          restore.node = resolve;
          if (!isMobile) restore.emphasis = () => emphasizeForNode(node);
        }
      }

      const centerX = (node.x0 + node.x1) / 2;
      const boxHeight = node.y1 - node.y0;
      const topY = node.y0 + 10;

      // Calculate space requirements
      const labelBoxHeight = 18;
      const energyValueHeight = 20;
      const kwhUnitHeight = 8;
      const percentageHeight = 12;
      const spacing = 15;

      // Minimum heights needed for each element
      const minHeightForLabel = MIN_HEIGHT_FOR_LABEL; // = labelBoxHeight + 10 (label + some padding)
      const minHeightForValue = minHeightForLabel + energyValueHeight + spacing;
      const minHeightForUnit = 65; // Show kWh unit when box is at least 65px tall
      const minHeightForPercentage = 100; // Show percentage when box is at least 100px tall

      // Only show elements if there's enough room
      if (boxHeight >= minHeightForLabel) {
        // Add label box with background
        const labelBoxWidth = 80;
        const labelBoxX = centerX - labelBoxWidth / 2;
        // When only showing label (no value), center the label box vertically
        const labelBoxY =
          boxHeight < minHeightForValue
            ? node.y0 + (boxHeight - labelBoxHeight) / 2
            : topY - 2;

        const labelBox = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect",
        );
        labelBox.setAttribute("x", String(labelBoxX));
        labelBox.setAttribute("y", String(labelBoxY));
        labelBox.setAttribute("width", String(labelBoxWidth));
        labelBox.setAttribute("height", String(labelBoxHeight));
        labelBox.setAttribute("fill", "rgba(255, 255, 255, 0.2)");
        labelBox.setAttribute("rx", "3");
        labelBox.setAttribute("pointer-events", "none");
        svgElement.appendChild(labelBox);

        // Add label text inside box
        const nameText = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text",
        );
        nameText.setAttribute("x", String(centerX));
        nameText.setAttribute("y", String(labelBoxY + labelBoxHeight / 2 + 1));
        nameText.setAttribute("text-anchor", "middle");
        nameText.setAttribute("dominant-baseline", "middle");
        nameText.setAttribute("font-family", "DM Sans, sans-serif");
        nameText.setAttribute("font-size", "11px");
        nameText.setAttribute("font-weight", "500");
        nameText.setAttribute("fill", "#000000");
        nameText.setAttribute("pointer-events", "none");
        nameText.textContent = node.name.toUpperCase();
        svgElement.appendChild(nameText);

        if (boxHeight >= minHeightForValue) {
          // Add energy value directly under label box
          const energyText = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "text",
          );
          energyText.setAttribute("x", String(centerX));
          energyText.setAttribute("y", String(labelBoxY + labelBoxHeight + 20));
          energyText.setAttribute("text-anchor", "middle");
          energyText.setAttribute("font-family", "DM Sans, sans-serif");
          energyText.setAttribute("font-size", "20px");
          energyText.setAttribute("font-weight", "700");
          energyText.setAttribute("fill", "#000000");
          energyText.setAttribute("pointer-events", "none");
          energyText.textContent = formatFlowMagnitude(totalEnergy);
          svgElement.appendChild(energyText);

          if (boxHeight >= minHeightForUnit) {
            // Add kWh unit
            const unitText = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "text",
            );
            unitText.setAttribute("x", String(centerX));
            unitText.setAttribute("y", String(labelBoxY + labelBoxHeight + 33));
            unitText.setAttribute("text-anchor", "middle");
            unitText.setAttribute("font-family", "DM Sans, sans-serif");
            unitText.setAttribute("font-size", "8px");
            unitText.setAttribute("fill", "#000000");
            unitText.setAttribute("opacity", "0.8");
            unitText.setAttribute("pointer-events", "none");
            unitText.textContent = unit;
            svgElement.appendChild(unitText);
          }
        }

        if (boxHeight >= minHeightForPercentage) {
          // Add percentage at bottom
          const percentText = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "text",
          );
          percentText.setAttribute("x", String(centerX));
          percentText.setAttribute("y", String(node.y1 - 10));
          percentText.setAttribute("text-anchor", "middle");
          percentText.setAttribute("font-family", "DM Sans, sans-serif");
          percentText.setAttribute("font-size", "12px");
          percentText.setAttribute("font-weight", "600");
          percentText.setAttribute("fill", "#000000");
          percentText.setAttribute("pointer-events", "none");
          percentText.textContent = `${percentage}%`;
          svgElement.appendChild(percentText);
        }
      }
    });

    // Add column headers, driven by the discovered columns: leftmost = SOURCES, rightmost = LOADS, any
    // interior column (only present in battery-middle) = STORAGE.
    const drawColumnHeader = (text: string, columnNodes: any[]) => {
      if (columnNodes.length === 0) return;
      const n = columnNodes[0];
      const x = (n.x0 + n.x1) / 2;
      const label = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      label.setAttribute("x", String(x));
      label.setAttribute("y", String(margin.top - 10));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("font-family", "DM Sans, sans-serif");
      label.setAttribute("font-size", "12px");
      label.setAttribute("font-weight", "600");
      label.setAttribute("fill", "#FFFFFF");
      label.setAttribute("opacity", "0.7");
      label.textContent = text;
      svgElement.appendChild(label);
    };

    for (const x of columnXs) {
      const text =
        x === minColumnX ? "SOURCES" : x === maxColumnX ? "LOADS" : "STORAGE";
      drawColumnHeader(text, columnsByX.get(x) ?? []);
    }

    // Carry the open tooltip across the rebuild, re-resolved against the layout just built (fresh
    // content AND fresh geometry — a refreshed window can move the node it points at). Both setters run
    // unconditionally: with nothing to restore they pass `null`, which is a no-op when nothing was open.
    setHovered(restore.node ? restore.node() : null);
    setHoveredLink(restore.link ? restore.link() : null);
    restore.emphasis?.();

    // Safety net for the restored hover: the pointer is sitting over an element that no longer exists,
    // so the `mouseleave` that would normally close the panel may never fire for the node/ribbon it was
    // on. Leaving the diagram entirely always closes both.
    if (!isMobile) {
      svgElement.addEventListener("mouseleave", () => {
        setHovered(null);
        setHoveredLink(null);
        resetEmphasis();
      });
    }
    // `nodeTooltip` deliberately excluded — see `nodeTooltipRef`'s comment above; a resolver-identity-only
    // change must not force a full `svg.innerHTML = ""` rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix, unit, layout, actualWidth, height, isMobile]);

  // Position the hovered/tapped node's tooltip panel(s) in SCREEN space (the SVG has no viewBox/CSS
  // sizing, so SVG user px == CSS px — `sx`/`sy` below are 1 today, kept as scale guards). A beaked panel
  // sits on the LEFT of a left-column node, the RIGHT of a right-column node, or BOTH for the interior
  // battery-middle node, clamped to the node band (`bandTopVp`/`bandBottomVp`). Where there's no room
  // beside the node — always on mobile (no margins there), or a desktop window too narrow — the SAME
  // panel is centred in the gap between the columns instead, still facing (and beaked toward) its node.
  // Measure-then-reveal: an immediate hidden pass (estimated height, avoids a flash at the wrong spot)
  // then a real-height pass once the panel is mounted and measurable.
  useLayoutEffect(() => {
    if (!hovered || !svgRef.current) {
      setPlacementL(null);
      setPlacementR(null);
      return;
    }

    const GAP = 12;
    const PAD = 8;
    // Captured into a local `const` so `isDualTooltip`'s narrowing survives into the nested `compute`
    // calls and the `requestAnimationFrame` callback below (TS narrows a `const` through closures; it
    // would NOT narrow a re-derived boolean flag or a repeated `hovered.content` property access).
    const content = hovered.content;

    const compute = (
      side: "left" | "right",
      ref: React.RefObject<HTMLDivElement | null>,
      estimatedHeight: number,
    ): PanelPlacement => {
      const svg = svgRef.current!;
      const r = svg.getBoundingClientRect();
      const sx = r.width / actualWidth;
      const sy = r.height / height;
      const geom = geomRef.current;
      const bandTopVp = r.top + (geom?.bandTop ?? MARGIN_TOP) * sy;
      const bandBottomVp =
        r.top + (geom?.bandBottom ?? height - MARGIN_BOTTOM) * sy;

      const { x0, x1, y0, y1 } = hovered.geomSvg;
      const nodeLeftVp = r.left + x0 * sx;
      const nodeRightVp = r.left + x1 * sx;
      const nodeTopVp = r.top + y0 * sy;
      const nodeBottomVp = r.top + y1 * sy;
      const nodeCenterYVp = r.top + ((y0 + y1) / 2) * sy;
      const nodeHeightVp = nodeBottomVp - nodeTopVp;

      const H = ref.current?.offsetHeight || estimatedHeight;
      const clampX = (l: number) =>
        Math.max(PAD, Math.min(l, window.innerWidth - PANEL_WIDTH - PAD));

      // Horizontal: beside the node when it fits (desktop's outer margins), otherwise centred in the
      // gap between the node's column and the next one over — which is where mobile always lands, since
      // the diagram spans the full viewport there and the columns hug its edges.
      let panelSide = side;
      let left = clampX(
        side === "left" ? nodeLeftVp - GAP - PANEL_WIDTH : nodeRightVp + GAP,
      );
      const fitsBeside =
        side === "left"
          ? left + PANEL_WIDTH <= nodeLeftVp
          : left >= nodeRightVp;
      if (!fitsBeside) {
        const cols = geom?.columns ?? [];
        const i = cols.findIndex((c) => Math.round(c.x0) === Math.round(x0));
        // Prefer the neighbouring column on `side`; an outermost node (the usual case) has none there,
        // so fall to the other side and FLIP the panel with it — the beak has to face the node.
        let neighbour =
          i < 0 ? undefined : cols[side === "left" ? i - 1 : i + 1];
        if (i >= 0 && !neighbour) {
          neighbour = cols[side === "left" ? i + 1 : i - 1];
          if (neighbour) panelSide = side === "left" ? "right" : "left";
        }
        // Two columns → the SOURCES↔LOADS channel; three (battery-middle) → the dual battery panels get
        // their own left and right channels instead of stacking on top of each other.
        const gapCentreSvg = !neighbour
          ? actualWidth / 2
          : panelSide === "left"
            ? (neighbour.x1 + x0) / 2
            : (x1 + neighbour.x0) / 2;
        left = clampX(r.left + gapCentreSvg * sx - PANEL_WIDTH / 2);
      }

      // Vertical anchoring: the topmost node in a column top-aligns the panel (its top edge = the
      // node's top edge), the bottommost bottom-aligns it, everything else centres on the node. This
      // stops a tall edge node's centred panel from drifting to the band middle, away from the node.
      const desiredTop =
        hovered.vertPos === "top"
          ? nodeTopVp
          : hovered.vertPos === "bottom"
            ? nodeBottomVp - H
            : nodeCenterYVp - H / 2;
      const top = Math.max(bandTopVp, Math.min(desiredTop, bandBottomVp - H));

      // Beak placement. The beak joins two boxes of different heights, and the SHORTER of the two decides
      // where it sits: centre it on the short box, which the tall one then has room to spare around.
      // So a panel beside a much taller node sits at the PANEL's centre, and a panel beside a short node
      // (or a tall panel clamped to the band) sits at the NODE's centre — either way the beak looks
      // centred on the thing that constrains it, never stranded at a corner. Short node (shorter than the
      // diamond): a half beak whose flat edge sits on the node's near edge — its BOTTOM edge for a
      // bottom/middle node, its TOP edge for a top node — so the beak hugs the thin node instead of the
      // diamond floating past it. A panel sitting ON its node (a phone too narrow for the gap, or the
      // interior battery node) gets no beak at all — one pointing at the node underneath just reads as a
      // rendering glitch. `beakTop` is the y (in panel coords) of that flat edge (half beak) or the
      // diamond's centre (diamond); see NodeTooltip.
      let beakVariant: PanelPlacement["beakVariant"] = "diamond";
      let beakTop = 0;
      if (left < nodeRightVp && left + PANEL_WIDTH > nodeLeftVp) {
        beakVariant = "none";
      } else if (nodeHeightVp < BEAK_SIZE) {
        if (hovered.vertPos === "top") {
          beakVariant = "half-top";
          beakTop = Math.max(0, Math.min(nodeTopVp - top, H - HALF_BEAK_SIZE));
        } else {
          beakVariant = "half-bottom";
          beakTop = Math.max(HALF_BEAK_SIZE, Math.min(nodeBottomVp - top, H));
        }
      } else if (nodeHeightVp <= H) {
        // Node is the shorter box — centre on it (then keep the diamond on the panel).
        beakTop = nodeCenterYVp - top;
      } else {
        // Panel is the shorter box — centre on it, clamped into the node's span (inset by the diamond's
        // half-height, so the WHOLE beak lands on the node, not just its centre).
        const lo = nodeTopVp - top + BEAK_HALF_SPAN;
        const hi = nodeBottomVp - top - BEAK_HALF_SPAN;
        beakTop = Math.max(lo, Math.min(H / 2, hi));
      }
      if (beakVariant === "diamond") {
        beakTop = Math.max(12, Math.min(beakTop, Math.max(H - 12, 12)));
      }
      return {
        side: panelSide,
        left,
        top,
        beakTop,
        beakVariant,
        visible: true,
      };
    };

    const ESTIMATE_FULL = 300;
    const ESTIMATE_LIMITED = 110;
    const estimateFor = (c: SankeyNodeTooltip) =>
      c.variant === "full" ? ESTIMATE_FULL : ESTIMATE_LIMITED;

    const sideFor = (): "left" | "right" =>
      hovered.columnPos === "right" ? "right" : "left";

    // Pass 1 (this tick): provisional placement, then pass 2 next frame once the panel is mounted and its
    // real `offsetHeight` is measurable. Pass 1 only has to HIDE the panel when it isn't mounted yet and
    // the height is a guess — moving between nodes (or a refresh that restores the tooltip) re-runs this
    // with the panel already in the DOM, where `compute` measures it for real and can show it right away.
    const mounted = (ref: React.RefObject<HTMLDivElement | null>) =>
      ref.current != null;

    if (isDualTooltip(content)) {
      const l = compute("left", panelRefL, estimateFor(content.left));
      const rr = compute("right", panelRefR, estimateFor(content.right));
      setPlacementL({ ...l, visible: mounted(panelRefL) });
      setPlacementR({ ...rr, visible: mounted(panelRefR) });

      const raf = requestAnimationFrame(() => {
        setPlacementL(compute("left", panelRefL, ESTIMATE_FULL));
        setPlacementR(compute("right", panelRefR, ESTIMATE_FULL));
      });
      return () => cancelAnimationFrame(raf);
    }

    const s = sideFor();
    const ref = s === "left" ? panelRefL : panelRefR;
    const p = compute(s, ref, estimateFor(content));
    if (s === "left") {
      setPlacementL({ ...p, visible: mounted(ref) });
      setPlacementR(null);
    } else {
      setPlacementR({ ...p, visible: mounted(ref) });
      setPlacementL(null);
    }

    const raf = requestAnimationFrame(() => {
      const p2 = compute(
        s,
        s === "left" ? panelRefL : panelRefR,
        estimateFor(content),
      );
      if (s === "left") setPlacementL(p2);
      else setPlacementR(p2);
    });
    return () => cancelAnimationFrame(raf);
  }, [hovered, isMobile, actualWidth, height]);

  // Clamp the hovered spline's tooltip into the same node band the node panels use. The card centres on
  // the spline midpoint, so a ribbon meeting a node near the top or bottom of the diagram would otherwise
  // hang past the end of it. The clamp needs the card's real height (one line or two, depending on
  // whether the attributed detail line is present), so it's measured rather than estimated.
  useLayoutEffect(() => {
    if (!hoveredLink || !svgRef.current) {
      setLinkTop(null);
      return;
    }
    const place = () => {
      const svg = svgRef.current;
      const H = linkPanelRef.current?.offsetHeight ?? 0;
      if (!svg || !H) return; // not mounted yet — the rAF pass below picks it up
      const r = svg.getBoundingClientRect();
      const sy = r.height / height;
      const geom = geomRef.current;
      const bandTopVp = r.top + (geom?.bandTop ?? MARGIN_TOP) * sy;
      const bandBottomVp =
        r.top + (geom?.bandBottom ?? height - MARGIN_BOTTOM) * sy;
      const lo = bandTopVp + H / 2;
      const hi = bandBottomVp - H / 2;
      setLinkTop(
        lo <= hi
          ? Math.max(lo, Math.min(hoveredLink.top, hi))
          : (bandTopVp + bandBottomVp) / 2,
      );
    };
    // Sweeping from one spline to the next, the card is still mounted — its height is known HERE, before
    // paint, so the clamped position lands without a hidden frame. Only the first spline of a hover run
    // (nothing mounted, `linkTop` null ⇒ rendered hidden at the raw midpoint) needs the measure pass.
    place();
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [hoveredLink, height]);

  // Dismissal: outside tap (touch devices), scroll (capture-phase — a `position:fixed` panel would
  // otherwise detach from its node), and resize all close the tooltip.
  useEffect(() => {
    if (!hovered && !hoveredLink) return;
    const close = () => {
      setHovered(null);
      setHoveredLink(null);
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    const handleTouchOutside = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (
        !target.closest(".sankey-node-hit") &&
        !target.closest(".sankey-link-hit") &&
        !target.closest(".node-tooltip") &&
        !target.closest(".link-tooltip")
      ) {
        setHovered(null);
        setHoveredLink(null);
      }
    };
    const isTouch = "ontouchstart" in window;
    if (isTouch) document.addEventListener("touchstart", handleTouchOutside);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      if (isTouch)
        document.removeEventListener("touchstart", handleTouchOutside);
    };
  }, [hovered, hoveredLink]);

  const panels: {
    key: "left" | "right";
    data: SankeyNodeTooltip;
    placement: PanelPlacement | null;
    ref: React.RefObject<HTMLDivElement | null>;
    color: string;
    /** Omit the heading when the node box already shows its own title (see `titleVisibleInNode`). */
    showHeading: boolean;
  }[] = hovered
    ? isDualTooltip(hovered.content)
      ? [
          {
            key: "left" as const,
            data: hovered.content.left,
            placement: placementL,
            ref: panelRefL,
            color: hovered.color,
            showHeading: !hovered.titleVisibleInNode,
          },
          {
            key: "right" as const,
            data: hovered.content.right,
            placement: placementR,
            ref: panelRefR,
            color: hovered.color,
            showHeading: !hovered.titleVisibleInNode,
          },
        ]
      : hovered.columnPos === "right"
        ? [
            {
              key: "right" as const,
              data: hovered.content,
              placement: placementR,
              ref: panelRefR,
              color: hovered.color,
              showHeading: !hovered.titleVisibleInNode,
            },
          ]
        : [
            {
              key: "left" as const,
              data: hovered.content,
              placement: placementL,
              ref: panelRefL,
              color: hovered.color,
              showHeading: !hovered.titleVisibleInNode,
            },
          ]
    : [];

  return (
    <>
      <div ref={containerRef} className="w-full flex justify-center">
        <svg
          ref={svgRef}
          width={actualWidth}
          height={height}
          className="energy-flow-sankey"
        />
      </div>
      {typeof document !== "undefined" &&
        panels.map(
          (p) =>
            p.placement &&
            createPortal(
              <NodeTooltip
                key={p.key}
                data={p.data}
                nodeColor={p.color}
                side={p.placement.side}
                left={p.placement.left}
                top={p.placement.top}
                beakTop={p.placement.beakTop}
                beakVariant={p.placement.beakVariant}
                showHeading={p.showHeading}
                hidden={!p.placement.visible}
                panelRef={p.ref}
              />,
              document.body,
            ),
        )}
      {typeof document !== "undefined" &&
        hoveredLink &&
        createPortal(
          <LinkTooltip
            data={hoveredLink.content}
            color={hoveredLink.color}
            left={hoveredLink.left}
            top={linkTop ?? hoveredLink.top}
            hidden={linkTop === null}
            panelRef={linkPanelRef}
          />,
          document.body,
        )}
    </>
  );
}
