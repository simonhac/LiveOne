"use client";

/**
 * The single page-header temporal navigator. Sources `timezoneOffsetMin` from the primary section's
 * live data the same way the cards do (React Query dedupes — the section's cards already fetch this
 * key), then renders the shared {@link TemporalNavigator} unchanged. The host decides WHETHER to
 * render this (see `hasTimeTravelingCard`); this component only resolves the tz + draws the control.
 */
import { useQuery } from "@tanstack/react-query";
import { dashboardDataQuery } from "@/lib/queries";
import type { AreaDatum } from "@/components/dashboard/cards/shared";
import TemporalNavigator from "@/components/TemporalNavigator";

export function HeaderTemporalNav({
  handle,
  timezoneOffsetMin,
}: {
  /** The primary section's Area handle — whose live `system.timezoneOffsetMin` labels the range. */
  handle: number;
  /** Immediate tz fallback (the device route already knows its system tz); refined by the query. */
  timezoneOffsetMin?: number;
}) {
  const { data } = useQuery(dashboardDataQuery(handle));
  // tz only drives the label + prev/next encoding; decode uses the URL's own offset, so an initial
  // default self-corrects. 600 = AEST, matching the cards' fallback.
  const tz =
    (data as AreaDatum | undefined)?.system?.timezoneOffsetMin ??
    timezoneOffsetMin ??
    600;
  return <TemporalNavigator timezoneOffsetMin={tz} />;
}
