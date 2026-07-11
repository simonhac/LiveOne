/**
 * The inspector view — combines the running entries (core/usher) with their last-tick state
 * (state/usher-state) and each source's live snapshot(). Serialized by the SSE + JSON routes.
 */

import { getEntries } from "../core/usher";
import { getTickState, type SourceTickState } from "./usher-state";

export interface SourceView {
  siteId: string;
  /** source kind — "musher" | "fusher" */
  name: string;
  /** push cadence (s) */
  intervalSec: number;
  /** faster push cadence while running (s), if any */
  activeIntervalSec?: number;
  tick?: SourceTickState;
  /** source-specific live detail (fusher: site power/energy + inverters + minutely; musher: values) */
  snapshot?: unknown;
}

export interface UsherView {
  at: string;
  started: boolean;
  sources: SourceView[];
}

export function getUsherView(): UsherView {
  const entries = getEntries();
  const sources: SourceView[] = entries.map((e) => {
    let snapshot: unknown;
    try {
      snapshot = e.source.snapshot?.();
    } catch {
      snapshot = undefined;
    }
    return {
      siteId: e.source.siteId,
      name: e.source.name,
      intervalSec: e.intervalMs / 1000,
      activeIntervalSec: e.activeIntervalMs
        ? e.activeIntervalMs / 1000
        : undefined,
      tick: getTickState(e.source.siteId),
      snapshot,
    };
  });
  return {
    at: new Date().toISOString(),
    started: entries.length > 0,
    sources,
  };
}
