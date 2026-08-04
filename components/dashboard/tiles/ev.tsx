"use client";

import TeslaSmallCard from "@/components/TeslaSmallCard";
import type { TilePlugin } from "./types";
import { getPointValue } from "./shared";
import { TESLA_CHARGE_CONTROL_PATHS } from "@/lib/control/point-ref";
import { areaIdOfDatum } from "@/lib/automations/progress";

export const evTile: TilePlugin = {
  kind: "tile",
  type: "ev",
  isAvailable: ({ latest }) => getPointValue(latest, "ev.battery/soc") !== null,
  // The cog commands THESE points, so ownership of THEIR device is what gates it — see
  // `datumCanControlPoint`. Availability is still keyed on `ev.battery/soc`, which is the tile's
  // data, not its controls.
  controlPaths: TESLA_CHARGE_CONTROL_PATHS,
  // Same container-query box model as AmberSmallCard — see the note on `amberTile`.
  skeletonClass: "@container @[180px]:min-h-[180px] min-w-[66px] self-stretch",
  // Charge limits are AREA-scoped (`/api/v4/automations?area=ar_…`), so the card needs the id of
  // the subject this tile was served as — present only on an area payload, absent (null) for a
  // device subject and for prop-driven hosts.
  Render: ({ latest, data, systemId, canControl }) => (
    <TeslaSmallCard
      latest={latest}
      systemId={systemId}
      canControl={canControl}
      areaId={areaIdOfDatum(data)}
    />
  ),
};
