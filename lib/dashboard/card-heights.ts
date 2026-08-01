/**
 * Remembered card heights — the self-correcting half of the dashboard's layout stability.
 *
 * A card's DECLARED footprint (`CardPlugin.footprint`, components/dashboard/cards/footprints.ts) is
 * a static best estimate, and for several cards a static estimate is all it can ever be: a
 * device-metrics grid is as tall as the device has points, a generator-run table as tall as the
 * period has runs, an amber strip as wide-and-tall as its forecast. Those are only knowable AFTER
 * the fetch the placeholder exists to cover. So the renderer measures each settled card once and
 * reserves that exact height the next time the same node is drawn.
 *
 * WHY A COOKIE AND NOT `localStorage`. The dashboard is server-rendered: `/dashboard/[...slug]`
 * paints the whole card tree in the SSR HTML before any client JS runs. `localStorage` is
 * unreadable there, so a height learned that way could only be applied in a post-hydration effect —
 * which would ADD a shift (SSR paint at the declared footprint, then a patch to the remembered one)
 * rather than remove one. A cookie is readable by the RSC, so the remembered heights are baked into
 * the first painted frame and there is no hydration mismatch to reconcile.
 *
 * It is a rendering HINT and nothing else. A corrupt, stale, forged or absent cookie costs at most
 * one card's worth of relayout on one load — every read falls back to the declared footprint — so
 * this parses defensively and never throws.
 *
 * Server-safe: no React, no DOM, no db. (`lib/` is also the only place jest can see — the
 * `roots` are lib/app/scripts/packages.)
 */

/** Not `httpOnly` — the client writes it after measuring. Read by the RSC via `cookies()`. */
export const CARD_HEIGHTS_COOKIE = "lo_ch";

/** 90 days. Long, because the value of the cookie is precisely that it survives between visits. */
export const CARD_HEIGHTS_MAX_AGE = 90 * 24 * 60 * 60;

/**
 * How many dashboards' worth of heights to keep, and how many entries each. Small on purpose: this
 * rides on every request to the origin, so it is capped by entry count AND by serialized length,
 * and the current dashboard is always the one that survives eviction.
 */
const MAX_DASHBOARDS = 3;
const MAX_ENTRIES_PER_DASHBOARD = 60;
const MAX_SERIALIZED_LEN = 2000;

/** Ignore anything outside this: a 0 is a card that hasn't rendered, a 5000 is a bug. */
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 4000;

/**
 * The viewport bucket a set of heights was learned at. Card heights are width-dependent (a stat
 * grid reflows 2→3→4 columns, a tile grid changes its column count, a chart's side table moves
 * from beside it to below it), so heights learned on a phone must not be replayed on a desktop.
 *
 * ONE tier is stored for the whole cookie rather than a map per tier: the RSC cannot know the
 * viewport, so it could not pick between them anyway. When the client notices it is rendering at a
 * different tier than the cookie was written at, it drops what it has and relearns — one load's
 * worth of imprecision after a device rotation or a window resize across a breakpoint.
 */
export type ViewportTier = "sm" | "md" | "lg";

/** Tailwind's `sm` (640) and `lg` (1024), which are the breakpoints the cards' own layouts turn on. */
export function viewportTier(width: number): ViewportTier {
  if (width < 640) return "sm";
  if (width < 1024) return "md";
  return "lg";
}

export interface CardHeightStore {
  tier: ViewportTier;
  /** dashboard id (or device-view key) → node key → measured height in CSS px. */
  byDashboard: Record<string, Record<string, number>>;
}

export function emptyCardHeightStore(
  tier: ViewportTier = "lg",
): CardHeightStore {
  return { tier, byDashboard: {} };
}

/**
 * The per-node identity a height is filed under.
 *
 * `node.id` first — every v4 document the writer produces gives each node a stable `n_…` id, so a
 * height survives the node moving within its dashboard. The index path is the fallback for a
 * hand-written or legacy doc whose nodes have no ids. The card TYPE is appended either way, so a
 * node that gets retyped in the configurator can never inherit the old type's height.
 */
export function cardHeightKey(
  nodeId: string | undefined,
  path: readonly number[],
  type: string,
): string {
  return `${nodeId ?? `@${path.join(".")}`}:${type}`;
}

/** The remembered height for one node, or `undefined` — the caller falls back to the footprint. */
export function rememberedHeight(
  store: CardHeightStore | null | undefined,
  dashboardId: string | null | undefined,
  key: string,
): number | undefined {
  if (!store || !dashboardId) return undefined;
  const h = store.byDashboard[dashboardId]?.[key];
  return typeof h === "number" ? h : undefined;
}

/**
 * Parse the cookie value. Wire shape is deliberately terse (`v`/`t`/`d`) because it is length-capped:
 *
 *   {"v":1,"t":"lg","d":{"db_…":{"n_7:chart":403}}}
 *
 * Anything unrecognised — a future `v`, a truncated string, a number out of range — yields an empty
 * store rather than an error. Losing the hint is a paint, not a failure.
 */
export function parseCardHeights(
  raw: string | null | undefined,
): CardHeightStore {
  if (!raw) return emptyCardHeightStore();
  try {
    const decoded = raw.startsWith("{") ? raw : decodeURIComponent(raw);
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object") return emptyCardHeightStore();
    const o = parsed as { v?: unknown; t?: unknown; d?: unknown };
    if (o.v !== 1) return emptyCardHeightStore();
    const tier: ViewportTier =
      o.t === "sm" || o.t === "md" || o.t === "lg" ? o.t : "lg";
    const store = emptyCardHeightStore(tier);
    if (!o.d || typeof o.d !== "object") return store;
    for (const [dashboardId, entries] of Object.entries(
      o.d as Record<string, unknown>,
    )) {
      if (!entries || typeof entries !== "object") continue;
      const clean: Record<string, number> = {};
      for (const [key, value] of Object.entries(
        entries as Record<string, unknown>,
      )) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const h = Math.round(value);
        if (h < MIN_HEIGHT || h > MAX_HEIGHT) continue;
        clean[key] = h;
      }
      if (Object.keys(clean).length > 0) store.byDashboard[dashboardId] = clean;
    }
    return store;
  } catch {
    return emptyCardHeightStore();
  }
}

/**
 * Serialize, applying the caps. `keepFirst` (the dashboard being viewed) is never the one evicted —
 * it is the only one whose heights are about to be used.
 *
 * Returns `null` when there is nothing worth writing, so the caller can skip the write entirely.
 */
export function serializeCardHeights(
  store: CardHeightStore,
  keepFirst?: string,
): string | null {
  // Most-relevant-first, so trimming from the tail drops the least useful entries.
  const ids = Object.keys(store.byDashboard).sort((a, b) =>
    a === keepFirst ? -1 : b === keepFirst ? 1 : 0,
  );
  const d: Record<string, Record<string, number>> = {};
  for (const id of ids.slice(0, MAX_DASHBOARDS)) {
    const entries = Object.entries(store.byDashboard[id]).slice(
      0,
      MAX_ENTRIES_PER_DASHBOARD,
    );
    if (entries.length > 0) d[id] = Object.fromEntries(entries);
  }
  if (Object.keys(d).length === 0) return null;

  let out = JSON.stringify({ v: 1, t: store.tier, d });
  // Length is the cap that actually protects the request; shed whole dashboards (from the tail,
  // never `keepFirst`) until it fits.
  while (out.length > MAX_SERIALIZED_LEN) {
    const shed = Object.keys(d).pop();
    if (!shed || Object.keys(d).length === 1) break;
    delete d[shed];
    out = JSON.stringify({ v: 1, t: store.tier, d });
  }
  // A single dashboard that still doesn't fit gets its entries trimmed rather than dropped whole.
  if (out.length > MAX_SERIALIZED_LEN) {
    const [only] = Object.keys(d);
    const entries = Object.entries(d[only]);
    while (out.length > MAX_SERIALIZED_LEN && entries.length > 1) {
      entries.pop();
      d[only] = Object.fromEntries(entries);
      out = JSON.stringify({ v: 1, t: store.tier, d });
    }
  }
  return out.length > MAX_SERIALIZED_LEN ? null : out;
}

/**
 * Fold a batch of fresh measurements into a store, returning a NEW store (or the same one when
 * nothing moved, so a caller can skip the cookie write). A tier change discards everything: the
 * old heights describe a layout that is no longer on screen.
 *
 * `tolerancePx` ignores sub-pixel and font-settling jitter — rewriting the cookie because a card
 * moved by half a pixel would be pure churn, and the value is only ever used as a `min-height`.
 */
export function withMeasurements(
  store: CardHeightStore,
  dashboardId: string,
  tier: ViewportTier,
  measured: Record<string, number>,
  tolerancePx = 2,
): CardHeightStore | null {
  const base: CardHeightStore =
    store.tier === tier ? store : emptyCardHeightStore(tier);
  const current = base.byDashboard[dashboardId] ?? {};
  const next: Record<string, number> = { ...current };
  let changed = base !== store;
  for (const [key, value] of Object.entries(measured)) {
    if (!Number.isFinite(value)) continue;
    const h = Math.round(value);
    if (h < MIN_HEIGHT || h > MAX_HEIGHT) continue;
    const prev = current[key];
    if (prev != null && Math.abs(prev - h) <= tolerancePx) continue;
    next[key] = h;
    changed = true;
  }
  if (!changed) return null;
  return {
    tier,
    byDashboard: { ...base.byDashboard, [dashboardId]: next },
  };
}
