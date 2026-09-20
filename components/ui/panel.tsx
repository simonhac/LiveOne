import type { ReactNode } from "react";
import { CHART_PANEL, CHART_PANEL_PAD } from "@/lib/charts/style";

export interface PanelProps {
  children: ReactNode;
  /** Rendered as a `<section>` when true — for a dashboard section, which is one. */
  as?: "div" | "section";
  /** Drop the built-in padding when the child owns its own edges (a full-bleed table). */
  padded?: boolean;
  className?: string;
}

/**
 * The one framed surface on a dashboard: hairline border, faint fill, `rounded-lg`.
 *
 * Exists so that "which box does this card live in?" has one answer. Before it, the same three
 * classes were retyped in eleven places with four different backgrounds, three border alphas and
 * two radii — see the drift table in docs/architecture/chart-style.md.
 *
 * 🛑 **A dashboard section does not render this any more, and nor does a card body.** The section
 * is a bold heading on the black page (see `SECTION_RUN_PAD`); a chart and a table each delimit
 * themselves. What is left for `Panel` is a box that genuinely stands alone on a page background:
 * the standalone pages (`/device/{id}/heatmap`, the labs pages), and the short notices — unknown
 * card type, misconfigured card, area unavailable — which are prose with no shape of their own.
 *
 * Not `"use client"` — it is three class names and a div.
 */
export default function Panel({
  children,
  as = "div",
  padded = true,
  className = "",
}: PanelProps) {
  const Tag = as;
  return (
    <Tag
      className={`${CHART_PANEL}${padded ? ` ${CHART_PANEL_PAD}` : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </Tag>
  );
}
