"use client";

import React from "react";
import { POWER_CARD_IDS, type PowerCardId } from "@/lib/dashboard/cards";
import type { LatestPointValues } from "@/lib/types/api";
import { usePowerCardNodes } from "@/app/components/cards/usePowerCardNodes";

interface SystemPowerCardsProps {
  latest: LatestPointValues;
  vendorType: string;
  getStaleThreshold: (vendorType: string) => number;
  showGrid: boolean;
  /** Layout mode: "horizontal" for full-width row, "sidebar" for vertical stack on desktop */
  layout?: "horizontal" | "sidebar";
  /** Additional CSS classes for the outer container */
  className?: string;
  /** System id — enables the Tesla charge-control dialog. */
  systemId?: number;
  /** Whether the current user may control the Tesla (owner or admin). */
  canControl?: boolean;
  /** Display order of the mini-cards (P2 customization). Defaults to POWER_CARD_IDS. */
  order?: PowerCardId[];
  /** Mini-cards explicitly hidden by the user (P2 customization). */
  hidden?: PowerCardId[];
}

/**
 * Power cards grid for composite and mondo systems.
 *
 * The actual card nodes (solar/load/battery/grid/amber/ev) + availability are built by the shared
 * {@link usePowerCardNodes} hook, so the Customize dialog can render the EXACT same cards. This
 * component only owns ordering (order/hidden customization) + the responsive grid layout.
 */
export default function SystemPowerCards({
  latest,
  vendorType,
  getStaleThreshold,
  showGrid,
  layout = "horizontal",
  className,
  systemId,
  canControl,
  order,
  hidden = [],
}: SystemPowerCardsProps) {
  const { available, cardNodes } = usePowerCardNodes({
    latest,
    vendorType,
    getStaleThreshold,
    showGrid,
    systemId,
    canControl,
  });

  // Render in the configured order, skipping hidden and unavailable cards. With the default
  // order and no hidden set this is exactly the historical card set/order.
  const hiddenSet = new Set<PowerCardId>(hidden);
  const renderOrder = (order ?? POWER_CARD_IDS).filter(
    (id) => available[id] && !hiddenSet.has(id),
  );
  const cardCount = renderOrder.length;

  // Determine grid columns based on layout mode
  const getGridClass = () => {
    if (layout === "sidebar") {
      // Sidebar: horizontal on mobile, vertical stack on desktop
      if (cardCount === 1) return "grid-cols-1";
      if (cardCount === 2) return "grid-cols-2 lg:grid-cols-1";
      if (cardCount === 3) return "grid-cols-3 lg:grid-cols-1";
      return "grid-cols-4 lg:grid-cols-1";
    }
    // Horizontal: dynamic columns based on card count
    if (cardCount === 1) return "grid-cols-1";
    if (cardCount === 2) return "grid-cols-2";
    if (cardCount === 3) return "grid-cols-3";
    if (cardCount === 4) return "grid-cols-4";
    if (cardCount === 5) return "grid-cols-3";
    // 6+ cards
    return "grid-cols-4 lg:grid-cols-6";
  };

  return (
    <div
      className={`px-1 ${layout === "sidebar" ? "h-full" : "mb-4"} ${className || ""}`}
    >
      <div
        className={`grid gap-2 lg:gap-4 ${getGridClass()} ${layout === "sidebar" ? "h-full lg:content-between" : "auto-rows-fr"}`}
      >
        {renderOrder.map((id) => (
          <React.Fragment key={id}>{cardNodes[id]}</React.Fragment>
        ))}
      </div>
    </div>
  );
}
