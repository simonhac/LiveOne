"use client";

/**
 * `<CardSlot>` — the box every non-tile card is drawn inside, and the thing that makes a dashboard
 * stop relayouting as it loads.
 *
 * It does two jobs, and they are the same job seen from either end of a page load:
 *
 *  1. RESERVE. From the very first painted frame the slot is `min-height:` the card's remembered
 *     height, or — the first time this node is ever drawn — the card type's declared footprint
 *     (`CardPlugin.footprint`). The card's own data can then land whenever it likes without moving
 *     anything below it.
 *  2. LEARN. Once the card has settled, the slot measures it and files the height under the node's
 *     key, so the next load reserves the real number instead of the estimate. This is what covers
 *     the cards whose height is a property of their DATA rather than their config — a
 *     device-metrics grid is as tall as the device has points, a generator-run table as tall as the
 *     period has runs — where no static footprint could ever be right.
 *
 * "Settled" is read off the DOM: a subtree containing any `[data-skeleton]` element is still a
 * placeholder, and measuring it would teach the slot the placeholder's height forever. Every
 * placeholder in the tree carries that attribute (components/ui/skeleton.tsx).
 *
 * WHY TWO DIVS. The outer one carries the `min-height`, so it is `max(reserved, content)`; the
 * inner one is auto-height, so measuring IT yields the card's true height even when the reservation
 * is currently larger. Measuring the outer box would ratchet: a card once remembered tall could
 * never be remembered short again.
 *
 * Tiles are deliberately NOT slotted. They live in an `auto-rows-fr` grid where the row equalises
 * its children's heights, so an extra wrapper would break the very mechanism that keeps them
 * aligned — and `/api/data`, the only thing a tile waits on, is SSR-prefetched, so tiles are rarely
 * a placeholder at all.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  CARD_HEIGHTS_COOKIE,
  CARD_HEIGHTS_MAX_AGE,
  emptyCardHeightStore,
  parseCardHeights,
  rememberedHeight,
  serializeCardHeights,
  viewportTier,
  withMeasurements,
  type CardHeightStore,
} from "@/lib/dashboard/card-heights";

interface CardHeightsValue {
  store: CardHeightStore | null;
  /** The key heights are filed under — a dashboard id, or a device view's own key. */
  scopeId: string | null;
}

const CardHeightsContext = createContext<CardHeightsValue>({
  store: null,
  scopeId: null,
});

/**
 * Seeds the remembered heights read from the request cookie by the RSC. Absent (a host that hasn't
 * been wired up, a story/lab page) simply means every card uses its declared footprint.
 */
export function CardHeightsProvider({
  store,
  scopeId,
  children,
}: {
  store?: CardHeightStore | null;
  scopeId?: string | null;
  children: ReactNode;
}) {
  return (
    <CardHeightsContext.Provider
      value={{ store: store ?? null, scopeId: scopeId ?? null }}
    >
      {children}
    </CardHeightsContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// The writer. One batched, debounced cookie write for the whole page rather than one per card.
//
// 🛑 Slots REGISTER themselves and are measured AT FLUSH TIME; they do not push a height in. That
// is not a micro-optimisation, it is the fix for a real corruption: on a client-side switch from
// one dashboard to another, React reuses the slot elements, so for a moment a slot whose props
// already say "dashboard B, node n_1" still contains dashboard A's laid-out DOM. Anything measured
// eagerly at that instant gets filed under B's key — which is how Daylesford came to reserve
// Kinkora's 1570px site-charts block. Measuring only after the debounce has gone quiet means the
// number written is always one the current DOM actually has.
// ---------------------------------------------------------------------------------------------

const FLUSH_DELAY_MS = 1500;

interface Registration {
  scopeId: string;
  key: string;
  el: HTMLElement;
}
const registry = new Set<Registration>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split("; ")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}

function flush() {
  flushTimer = null;
  // One page renders one scope; group anyway so a stray registration can't cross-contaminate.
  const byScope = new Map<string, Record<string, number>>();
  for (const reg of registry) {
    if (!reg.el.isConnected) continue;
    // Still a placeholder → recording now would teach the slot the placeholder's height, and it
    // would never learn the card's.
    if (reg.el.querySelector("[data-skeleton]")) continue;
    const h = reg.el.getBoundingClientRect().height;
    if (h <= 0) continue;
    const bucket = byScope.get(reg.scopeId) ?? {};
    bucket[reg.key] = h;
    byScope.set(reg.scopeId, bucket);
  }
  if (byScope.size === 0) return;

  // Re-read rather than trusting the SSR snapshot: another tab (or an earlier flush on this page)
  // may have written since, and this is a merge, not an overwrite.
  let store = parseCardHeights(readCookie(CARD_HEIGHTS_COOKIE));
  const tier = viewportTier(window.innerWidth);
  let lastScope: string | undefined;
  let changed = false;
  for (const [scopeId, measured] of byScope) {
    const next = withMeasurements(store, scopeId, tier, measured);
    if (next) {
      store = next;
      changed = true;
    }
    lastScope = scopeId;
  }
  if (!changed) return; // nothing actually moved
  const value = serializeCardHeights(store, lastScope);
  if (!value) return;
  document.cookie = `${CARD_HEIGHTS_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${CARD_HEIGHTS_MAX_AGE}; samesite=lax`;
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

// ---------------------------------------------------------------------------------------------

export function CardSlot({
  heightKey,
  footprint,
  children,
}: {
  /** `cardHeightKey(node.id, path, node.type)`; null disables both reserving and learning. */
  heightKey: string | null;
  /** The card type's declared footprint — the floor used until a real height has been learned. */
  footprint: number;
  children: ReactNode;
}) {
  const { store, scopeId } = useContext(CardHeightsContext);
  const innerRef = useRef<HTMLDivElement>(null);
  const learned =
    heightKey != null ? rememberedHeight(store, scopeId, heightKey) : undefined;

  useEffect(() => {
    const el = innerRef.current;
    if (!el || heightKey == null || scopeId == null) return;
    const registration: Registration = { scopeId, key: heightKey, el };
    registry.add(registration);

    // TWO observers, because either one alone misses a case:
    //  - ResizeObserver catches the card growing or shrinking (data landing, a window resize) but
    //    NOT a same-size swap — and the common case IS same-size, since a placeholder is
    //    deliberately the size of the card it replaces.
    //  - MutationObserver catches exactly that swap: the placeholder leaving the subtree is a
    //    childList mutation, and it is the moment the height becomes worth recording.
    // Neither one records anything itself; both just say "something happened, re-measure soon".
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(scheduleFlush)
        : null;
    ro?.observe(el);
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(scheduleFlush)
        : null;
    mo?.observe(el, { childList: true, subtree: true });
    scheduleFlush();
    return () => {
      registry.delete(registration);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [heightKey, scopeId]);

  return (
    <div style={{ minHeight: learned ?? footprint }}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

/** Re-exported so hosts have one import for the whole mechanism. */
export { emptyCardHeightStore, parseCardHeights };
export type { CardHeightStore };
