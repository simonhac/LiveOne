/**
 * The inspector view — combines the running entries (core/usher) with their last-tick state
 * (state/usher-state) and each source's live snapshot(). Serialized by the SSE + JSON routes.
 */

import { getEntries, getStore } from "../core/usher";
import { getTickState, type SourceTickState } from "./usher-state";
import type { BlackboxStats } from "../core/blackbox";
import type { SpoolStats } from "../core/spool";

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

/** On-disk store health for the inspector: journal + outage buffer + disk headroom. */
export interface StoreView {
  dataDir: string;
  /** free fraction of the store's filesystem (0..1), from the last maintenance pass */
  diskFreeFrac?: number;
  blackbox?: BlackboxStats;
  spool?: SpoolStats;
}

export interface UsherView {
  at: string;
  started: boolean;
  sources: SourceView[];
  store?: StoreView;
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
  const s = getStore();
  const store: StoreView | undefined = s
    ? {
        dataDir: s.dataDir,
        diskFreeFrac:
          s.blackbox?.statsSync().diskFreeFrac ??
          s.spool?.statsSync().diskFreeFrac,
        blackbox: s.blackbox?.statsSync(),
        spool: s.spool?.statsSync(),
      }
    : undefined;

  return {
    at: new Date().toISOString(),
    started: entries.length > 0,
    sources,
    store,
  };
}
