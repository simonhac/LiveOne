import {
  createReadMetrics,
  noopRead,
  type ReadIdentity,
} from "@liveone/telemetry";
import { getMeter } from "./telemetry";

let metrics: ReturnType<typeof createReadMetrics> | undefined;
export function beginProductionRead(identity?: ReadIdentity) {
  if (!identity) return noopRead;
  try {
    metrics ??= createReadMetrics(
      getMeter("liveone/production-reads"),
      "liveone-usher",
    );
    return metrics.begin(identity);
  } catch {
    return noopRead;
  }
}
