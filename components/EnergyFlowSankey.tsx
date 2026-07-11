"use client";

import { useEffect, useRef, useState } from "react";
import {
  sankey as d3Sankey,
  sankeyLinkHorizontal,
  SankeyGraph,
  SankeyNode,
  SankeyLink,
} from "d3-sankey";
import { EnergyFlowMatrix } from "@/lib/energy-flow-matrix";

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

interface EnergyFlowSankeyProps {
  matrix: EnergyFlowMatrix;
  /** Unit shown on node values + link tooltips: cumulative window energy ("kWh") or focused-point power ("kW"). */
  unit?: "kWh" | "kW";
  /** Column layout: classic two-column (default) or battery relocated to a middle STORAGE column. */
  layout?: SankeyLayout;
  width?: number;
  height?: number;
}

interface SankeyNodeData {
  /** Canonical flow path (e.g. "source.solar", "source.battery"); used to identify the battery. */
  id?: string;
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
}: EnergyFlowSankeyProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [actualWidth, setActualWidth] = useState(width);

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

    // Filter out sources and loads with < 0.1 kWh
    const MIN_ENERGY = 0.1;

    // Build the node/link model for the chosen layout. Each node carries its own `total`, so the draw
    // loop below reads it directly (no filtered→original index reverse-mapping). Columns are discovered
    // from the laid-out x-positions, so this supports 2 (columns) or 3 (battery-middle) columns.
    const { nodes, links } = buildFlowGraph(matrix, layout, MIN_ENERGY);

    // If there are no nodes or links, show a message instead of rendering
    if (nodes.length === 0 || links.length === 0) {
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
      ? { left: 0, right: 0, top: 35, bottom: 20 } // No margins on mobile
      : { left: 60, right: 60, top: 35, bottom: 20 };

    // Custom node sorting to control vertical order
    // Order from top to bottom: Solar, Other loads, House, Battery, Grid
    const getNodeOrder = (node: any): number => {
      // Access the name from the node's data
      const name = node.name || "";
      const lower = name.toLowerCase();

      if (lower.includes("solar")) return 0;
      if (lower.includes("house")) return 2;
      if (lower.includes("battery")) return 3;
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
      path.setAttribute("d", sankeyLinkHorizontal()(extendedLink) || "");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", `url(#gradient-${i})`);
      path.setAttribute("stroke-width", String(Math.max(1, link.width)));
      path.setAttribute("opacity", "0.6");
      path.setAttribute("class", "sankey-link");

      // Add hover effect
      path.addEventListener("mouseenter", () => {
        path.setAttribute("opacity", "0.9");
        path.setAttribute("stroke-width", String(Math.max(1, link.width) + 2));
      });
      path.addEventListener("mouseleave", () => {
        path.setAttribute("opacity", "0.6");
        path.setAttribute("stroke-width", String(Math.max(1, link.width)));
      });

      // Tooltip
      const title = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "title",
      );
      title.textContent = `${link.source.name} → ${link.target.name}: ${link.value.toFixed(1)} ${unit}`;
      path.appendChild(title);

      svgElement.appendChild(path);
    });

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
      const minHeightForLabel = labelBoxHeight + 10; // label + some padding
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
          energyText.textContent = totalEnergy.toFixed(1);
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

    const columnXs = [...columnsByX.keys()].sort((a, b) => a - b);
    const minColumnX = columnXs[0];
    const maxColumnX = columnXs[columnXs.length - 1];
    for (const x of columnXs) {
      const text =
        x === minColumnX ? "SOURCES" : x === maxColumnX ? "LOADS" : "STORAGE";
      drawColumnHeader(text, columnsByX.get(x) ?? []);
    }
  }, [matrix, unit, layout, actualWidth, height, isMobile]);

  return (
    <div ref={containerRef} className="w-full flex justify-center">
      <svg
        ref={svgRef}
        width={actualWidth}
        height={height}
        className="energy-flow-sankey"
      />
    </div>
  );
}
