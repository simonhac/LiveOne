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

interface EnergyFlowSankeyProps {
  matrix: EnergyFlowMatrix;
  width?: number;
  height?: number;
}

interface SankeyNodeData {
  name: string;
  color: string;
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
  if (lower.includes("rest of house")) return "House";

  return label;
}

// Colors now come from the matrix nodes (energy-flow-matrix.ts uses centralized colors)

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

    const filteredSources = matrix.sources.filter(
      (_, i) => matrix.sourceTotals[i] >= MIN_ENERGY,
    );
    const filteredLoads = matrix.loads.filter(
      (_, i) => matrix.loadTotals[i] >= MIN_ENERGY,
    );

    // Create mapping from original indices to filtered indices
    const sourceIndexMap = new Map<number, number>();
    const loadIndexMap = new Map<number, number>();

    let filteredSourceIdx = 0;
    matrix.sources.forEach((_, i) => {
      if (matrix.sourceTotals[i] >= MIN_ENERGY) {
        sourceIndexMap.set(i, filteredSourceIdx++);
      }
    });

    let filteredLoadIdx = 0;
    matrix.loads.forEach((_, i) => {
      if (matrix.loadTotals[i] >= MIN_ENERGY) {
        loadIndexMap.set(i, filteredLoadIdx++);
      }
    });

    // Prepare data for d3-sankey with custom colors and shortened labels
    const nodes: SankeyNodeData[] = [
      // Sources (left side)
      ...filteredSources.map((source) => ({
        name: shortenLabel(source.label),
        color: source.color, // Use color from matrix (centralized colors)
      })),
      // Loads (right side)
      ...filteredLoads.map((load) => ({
        name: shortenLabel(load.label),
        color: load.color, // Use color from matrix (centralized colors)
      })),
    ];

    const links: SankeyLinkData[] = [];
    const sourceCount = filteredSources.length;

    // Create links from matrix data (only for filtered sources/loads)
    for (let s = 0; s < matrix.sources.length; s++) {
      const filteredSourceIdx = sourceIndexMap.get(s);
      if (filteredSourceIdx === undefined) continue; // Skip filtered out sources

      for (let l = 0; l < matrix.loads.length; l++) {
        const filteredLoadIdx = loadIndexMap.get(l);
        if (filteredLoadIdx === undefined) continue; // Skip filtered out loads

        const value = matrix.matrix[s][l];
        if (value > 0.01) {
          // Only include links with meaningful energy flow
          links.push({
            source: filteredSourceIdx,
            target: sourceCount + filteredLoadIdx,
            value,
          });
        }
      }
    }

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

    // Configure sankey layout with responsive margins and node width
    const nodeWidth = isMobile ? 86 : 96; // 10px narrower on mobile
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

    // Align the top and bottom of both columns by adjusting gaps on the shorter side
    const sourceNodes = graph.nodes.slice(0, sourceCount);
    const loadNodes = graph.nodes.slice(sourceCount);

    if (sourceNodes.length > 0 && loadNodes.length > 0) {
      // Calculate total height of each side (from first node top to last node bottom)
      const sourceHeight =
        (sourceNodes[sourceNodes.length - 1] as any).y1 -
        (sourceNodes[0] as any).y0;
      const loadHeight =
        (loadNodes[loadNodes.length - 1] as any).y1 - (loadNodes[0] as any).y0;

      // Find which side is shorter and calculate the height difference
      const heightDiff = Math.abs(sourceHeight - loadHeight);

      // Only adjust if there's a meaningful difference (> 0.1px)
      if (heightDiff > 0.1) {
        const isShorterSide = sourceHeight < loadHeight;
        const shorterSide = isShorterSide ? sourceNodes : loadNodes;
        const numGaps = shorterSide.length - 1;

        // Track how much each node was shifted (for updating links later)
        const nodeShifts = new Map<any, number>();

        // Distribute the height difference evenly among the gaps
        if (numGaps > 0) {
          const additionalGapPerSpace = heightDiff / numGaps;

          // Adjust y positions for nodes on the shorter side
          // Start from index 1 (second node) since first node stays at top
          for (let i = 1; i < shorterSide.length; i++) {
            const node = shorterSide[i] as any;
            const shift = i * additionalGapPerSpace;
            const nodeHeight = node.y1 - node.y0;

            // Shift the node down by cumulative gap increase
            node.y0 += shift;
            node.y1 = node.y0 + nodeHeight; // Preserve node height

            // Record the shift amount for this node
            nodeShifts.set(node, shift);
          }

          // Update link coordinates to match shifted nodes
          graph.links.forEach((link: any) => {
            // If source node was shifted, adjust link's y0
            const sourceShift = nodeShifts.get(link.source);
            if (sourceShift !== undefined) {
              link.y0 += sourceShift;
            }

            // If target node was shifted, adjust link's y1
            const targetShift = nodeShifts.get(link.target);
            if (targetShift !== undefined) {
              link.y1 += targetShift;
            }
          });
        }
      }
    }

    // Create SVG container
    const svgElement = svg as any;

    // Add gradient definitions
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");

    graph.links.forEach((link: any, i: number) => {
      const gradient = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "linearGradient",
      );
      gradient.setAttribute("id", `gradient-${i}`);
      gradient.setAttribute("gradientUnits", "userSpaceOnUse");
      gradient.setAttribute("x1", String(link.source.x1));
      gradient.setAttribute(
        "y1",
        String(link.source.y0 + (link.source.y1 - link.source.y0) / 2),
      );
      gradient.setAttribute("x2", String(link.target.x0));
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

    // Draw links with gradients
    graph.links.forEach((link: any, i: number) => {
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", sankeyLinkHorizontal()(link) || "");
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
      title.textContent = `${link.source.name} → ${link.target.name}: ${link.value.toFixed(1)} kWh`;
      path.appendChild(title);

      svgElement.appendChild(path);
    });

    // Calculate total energy for filtered nodes
    const filteredTotalEnergy = [...sourceIndexMap.keys()].reduce(
      (sum, i) => sum + matrix.sourceTotals[i],
      0,
    );

    // Draw nodes with labels inside
    graph.nodes.forEach((node: any) => {
      const isSource = node.index < sourceCount;
      const nodeIdx = isSource ? node.index : node.index - sourceCount;

      // Get original index from filtered index
      let originalIdx = -1;
      if (isSource) {
        for (const [origIdx, filtIdx] of sourceIndexMap.entries()) {
          if (filtIdx === nodeIdx) {
            originalIdx = origIdx;
            break;
          }
        }
      } else {
        for (const [origIdx, filtIdx] of loadIndexMap.entries()) {
          if (filtIdx === nodeIdx) {
            originalIdx = origIdx;
            break;
          }
        }
      }

      const totalEnergy = isSource
        ? matrix.sourceTotals[originalIdx]
        : matrix.loadTotals[originalIdx];
      const percentage = ((totalEnergy / filteredTotalEnergy) * 100).toFixed(0);

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
            unitText.textContent = "kWh";
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

    // Add column headers
    if (graph.nodes.length > 0) {
      // Find leftmost source node and rightmost load node for positioning
      const sourceNodes = graph.nodes.slice(0, sourceCount);
      const loadNodes = graph.nodes.slice(sourceCount);

      if (sourceNodes.length > 0) {
        // "SOURCES" label above left column
        const firstSourceNode = sourceNodes[0] as any;
        const sourceLabelX = (firstSourceNode.x0 + firstSourceNode.x1) / 2;

        const sourcesLabel = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text",
        );
        sourcesLabel.setAttribute("x", String(sourceLabelX));
        sourcesLabel.setAttribute("y", String(margin.top - 10));
        sourcesLabel.setAttribute("text-anchor", "middle");
        sourcesLabel.setAttribute("font-family", "DM Sans, sans-serif");
        sourcesLabel.setAttribute("font-size", "12px");
        sourcesLabel.setAttribute("font-weight", "600");
        sourcesLabel.setAttribute("fill", "#FFFFFF");
        sourcesLabel.setAttribute("opacity", "0.7");
        sourcesLabel.textContent = "SOURCES";
        svgElement.appendChild(sourcesLabel);
      }

      if (loadNodes.length > 0) {
        // "LOADS" label above right column
        const firstLoadNode = loadNodes[0] as any;
        const loadLabelX = (firstLoadNode.x0 + firstLoadNode.x1) / 2;

        const loadsLabel = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "text",
        );
        loadsLabel.setAttribute("x", String(loadLabelX));
        loadsLabel.setAttribute("y", String(margin.top - 10));
        loadsLabel.setAttribute("text-anchor", "middle");
        loadsLabel.setAttribute("font-family", "DM Sans, sans-serif");
        loadsLabel.setAttribute("font-size", "12px");
        loadsLabel.setAttribute("font-weight", "600");
        loadsLabel.setAttribute("fill", "#FFFFFF");
        loadsLabel.setAttribute("opacity", "0.7");
        loadsLabel.textContent = "LOADS";
        svgElement.appendChild(loadsLabel);
      }
    }
  }, [matrix, actualWidth, height, isMobile]);

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
