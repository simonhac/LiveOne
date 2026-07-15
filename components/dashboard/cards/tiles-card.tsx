"use client";

/**
 * The `tiles` card — a section's grid of device-bound tiles, one self-contained <TileCell> per
 * descriptor tile, in order. The grid is a stable set of cells; each cell self-fetches and shows
 * its own skeleton until ready (no whole-grid swap). Tile views render via the tile plugin
 * registry (components/dashboard/tiles/) — whole-area and device-bound tiles share the SAME path:
 * a device tile just points its fetch at a member device.
 */
import { TILE_RENDERERS } from "@/components/dashboard/tiles/registry";
import type { TileView } from "@/lib/dashboard/v3";
import type { TileV3 } from "@/lib/dashboard/v3";
import type { CardPlugin } from "./types";
import { staleThreshold, TileSkeleton, useAreaDatum } from "./shared";

function tileKeyV3(t: TileV3, i: number): string {
  return t.id ?? `${t.view}-${t.deviceSystemId ?? "self"}-${i}`;
}

/**
 * One tile — self-fetches its system (`deviceSystemId ?? handle` — React Query dedupes, so all
 * whole-area tiles share one request; a device tile adds one), shows its own skeleton while
 * loading, then mounts the view's plugin when its `isAvailable` predicate passes.
 */
function TileCell({
  view,
  deviceSystemId,
  handleSystemId,
}: {
  view: TileView;
  deviceSystemId?: number;
  handleSystemId: number;
}) {
  const systemId = deviceSystemId ?? handleSystemId;
  const { data, datum, isLoading } = useAreaDatum(systemId);
  const latest = datum?.latest ?? {};

  if (isLoading) return <TileSkeleton />;

  const plugin = TILE_RENDERERS[view];
  if (!plugin) return null;

  const showGrid = !!latest["bidi.grid/power"];
  if (!plugin.isAvailable({ latest, data, showGrid })) return null;

  return (
    <plugin.Render
      latest={latest}
      data={data}
      systemId={systemId}
      staleThresholdSeconds={staleThreshold(
        datum?.system?.vendorType ?? "",
        datum?.system?.config?.updateCadenceSeconds,
      )}
      showGrid={showGrid}
      canControl={false}
    />
  );
}

function TilesCard({
  card,
  handle,
}: {
  card: { tiles?: TileV3[] };
  handle?: number;
}) {
  const visible = (card.tiles ?? []).filter((t) => !t.hidden);
  if (visible.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-4 auto-rows-fr px-1">
      {visible.map((t, i) =>
        handle == null ? (
          <TileSkeleton key={tileKeyV3(t, i)} />
        ) : (
          <TileCell
            key={tileKeyV3(t, i)}
            view={t.view}
            deviceSystemId={t.deviceSystemId}
            handleSystemId={handle}
          />
        ),
      )}
    </div>
  );
}

export const tilesPlugin: CardPlugin = {
  type: "tiles",
  // Renders its own skeleton cells while the Area handle resolves (count from the descriptor).
  pending: "self",
  Render: ({ card, handle }) => <TilesCard card={card} handle={handle} />,
};
