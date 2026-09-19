"use client";

import { useEffect, useRef, useState } from "react";
import { isScrollHeld, subscribeScrollHold } from "@/lib/charts/scroll-hold";

export interface ScrollStep {
  /** Current visibility. */
  hidden: boolean;
  /** Scroll offset at the previous step, and the page height it was read at. */
  lastY: number;
  lastHeight: number;
}

/**
 * One scroll step → the next state. Pure, so the direction logic is testable without a DOM.
 *
 * `y` must already be clamped to `[0, maxY]` — iOS rubber-banding past either end otherwise reads
 * as a direction change. Hides only on a downward step once past the header's own height (so the
 * top of the page never loses it); ANY upward step shows it again.
 *
 * 🛑 A step whose PAGE HEIGHT changed is layout, not the reader, and only resyncs the baseline.
 * That case is not hypothetical and not rare: Chrome's native scroll anchoring bumps `scrollY`
 * whenever content above the viewport grows, and that bump fires a `scroll` event indistinguishable
 * from a downward flick. A slow period (Y) lands its data after the header pin has expired, the
 * charts above the reader grow, and the header would slide away on its own with nobody touching the
 * screen. Anything that both scrolls the reader AND reflows the page costs one ignored step; the
 * next event, at a settled height, decides.
 */
export function scrollStep(
  prev: ScrollStep,
  y: number,
  height: number,
  headerHeight: number,
): ScrollStep {
  const base = { lastY: y, lastHeight: height };
  if (height !== prev.lastHeight) return { ...base, hidden: prev.hidden };
  if (y <= headerHeight) return { ...base, hidden: false };
  if (y > prev.lastY) return { ...base, hidden: true };
  if (y < prev.lastY) return { ...base, hidden: false };
  return { ...base, hidden: prev.hidden };
}

/**
 * Below Tailwind's `sm`, where the header's two rows are a real fraction of the screen. Written as
 * a max-width query so the boundary is the same 640px `sm:` uses, with no chance of the two
 * disagreeing by a pixel at exactly 640.
 */
const NARROW_SCREEN = "(max-width: 639.98px)";

/**
 * `true` while the page is being scrolled DOWN past the header; flips back on any scroll up. Scroll
 * container is the window. Scrolls made by `holdScrollAnchor` (lib/charts/scroll-hold.ts) are
 * compensation, not the reader, so they only resync the baseline — and for the whole of a temporal
 * change the header is held SHOWN, because the D|W|M|Y buttons the reader is aiming at live in it.
 * `pinned` forces it shown too (e.g. while a menu hanging off the header is open).
 *
 * 🛑 **Narrow viewports only** — always `false` from `sm` up. The whole justification for taking
 * the header away is that on a phone its two rows permanently eat a chunk of a short screen; on a
 * desktop they cost a sliver of a tall one, and moving them buys nothing while costing the reader
 * the D|W|M|Y buttons and the dashboard switcher every time they scroll down a page. This is a
 * viewport-WIDTH question, not a touch one: a touch laptop has the room, and a phone does not stop
 * being cramped when a mouse is paired to it.
 *
 * Reports `false` on the server and on the first client render, adopting the real answer in a mount
 * effect, so the two renders agree and hydration cannot mismatch — the same shape as
 * `useIsTouchDevice`. Erring "shown" for one frame is the safe direction.
 */
export function useHideOnScroll(
  headerRef: React.RefObject<HTMLElement | null>,
  pinned = false,
): boolean {
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(false);
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_SCREEN);
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(
    () =>
      subscribeScrollHold((p) => {
        heldRef.current = p;
        setHeld(p);
        // Nothing observed during a temporal change may latch: otherwise the state flips the
        // instant the pin lifts, which is the jump this exists to prevent.
        if (!p && hiddenRef.current) {
          hiddenRef.current = false;
          setHidden(false);
        }
      }),
    [],
  );

  useEffect(() => {
    const pageHeight = () => document.documentElement.scrollHeight;
    let state: ScrollStep = {
      hidden: false,
      lastY: window.scrollY,
      lastHeight: pageHeight(),
    };
    let raf = 0;
    const update = () => {
      raf = 0;
      const height = pageHeight();
      const maxY = Math.max(0, height - window.innerHeight);
      const y = Math.min(Math.max(window.scrollY, 0), maxY);
      if (heldRef.current || isScrollHeld()) {
        state = { ...state, lastY: y, lastHeight: height };
        return;
      }
      state = scrollStep(
        state,
        y,
        height,
        headerRef.current?.offsetHeight ?? 0,
      );
      if (state.hidden !== hiddenRef.current) {
        hiddenRef.current = state.hidden;
        setHidden(state.hidden);
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [headerRef]);

  return narrow && hidden && !pinned && !held;
}
