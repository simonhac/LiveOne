/**
 * Grid-signals context — the resolved facts needed to render a household's "Local Grid (NEM)" card:
 * which NEM region the Area sits in, and the public OpenElectricity system that serves that region's
 * live signals. Derived (never stored) from the Area's `location` via
 * `resolveGridContextForSystem` (lib/grid/context.ts).
 */

import type { NemRegion } from "@/lib/vendors/openelectricity/types";

export interface GridContext {
  /** The NEM region the Area sits in, derived from its location. */
  region: NemRegion;
  /** The public OpenElectricity `systems.id` that serves this region's live signals. */
  regionSystemId: number;
}
