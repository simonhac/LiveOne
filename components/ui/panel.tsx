import type { ReactNode } from "react";
import {
  CHART_PANEL,
  CHART_PANEL_BLEED,
  CHART_PANEL_PAD,
  CHART_PANEL_PAD_BLEED,
} from "@/lib/charts/style";

export interface PanelProps {
  children: ReactNode;
  /** Rendered as a `<section>` when true — for a dashboard section, which is one. */
  as?: "div" | "section";
  /** Drop the built-in padding when the child owns its own edges (a full-bleed table). */
  padded?: boolean;
  /**
   * Run to the screen edge below `sm` — no frame, no horizontal padding. For a DASHBOARD SECTION,
   * which spans the viewport anyway; see {@link CHART_PANEL_BLEED} for why this one breakpoint gate
   * is allowed where the per-card ones were not. A standalone page's panel does not want it: it is a
   * box on a page, not the page.
   */
  bleed?: boolean;
  className?: string;
}

/**
 * The one framed surface on a dashboard: hairline border, faint fill, `rounded-lg`.
 *
 * Exists so that "which box does this card live in?" has one answer. Before it, the same three
 * classes were retyped in eleven places with four different backgrounds, three border alphas and
 * two radii — see the drift table in docs/architecture/chart-style.md.
 *
 * 🛑 **A card body does not render this.** The section already does, and a filled card inside a
 * filled section is the nested-roundrect this whole change removes. `Panel` is for the OUTERMOST
 * box only: the v4 section, and the standalone pages (`/device/{id}/heatmap`, the labs pages) that
 * mount a panel component with no section around it and would otherwise render it naked on the
 * page background.
 *
 * Not `"use client"` — it is three class names and a div.
 */
export default function Panel({
  children,
  as = "div",
  padded = true,
  bleed = false,
  className = "",
}: PanelProps) {
  const Tag = as;
  const frame = bleed ? CHART_PANEL_BLEED : CHART_PANEL;
  const pad = bleed ? CHART_PANEL_PAD_BLEED : CHART_PANEL_PAD;
  return (
    <Tag
      className={`${frame}${padded ? ` ${pad}` : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </Tag>
  );
}
