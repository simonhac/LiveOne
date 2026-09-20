"use client";

import { useEffect, useRef } from "react";
import { isScrollHeld, subscribeScrollHold } from "@/lib/charts/scroll-hold";

/**
 * Where the header is. Two states, and the second is the whole trick:
 *
 * - `stuck` — inside the sticky host (`position: sticky; top: 0`), pinned to the top of the viewport.
 * - `free` — inside the free host (`position: relative; top: <top>px`): an ordinary part of the
 *   DOCUMENT, parked at page offset `top`. It is not moved on scroll at all; the page scrolls and it
 *   goes with it, so it leaves and re-enters the viewport pixel for pixel with the reader's finger,
 *   on the compositor, with no per-frame JS and no transition to lag behind.
 */
export interface HeaderPlacement {
  mode: "stuck" | "free";
  /** Page offset of the header's top edge while `free`. Meaningless while `stuck`. */
  top: number;
  /** Scroll offset at the previous step, and the page height it was read at. */
  lastY: number;
  lastHeight: number;
}

/**
 * One scroll step → the next placement. Pure, so the logic is testable without a DOM.
 *
 * `y` must already be clamped to `[0, maxY]` — iOS rubber-banding past either end otherwise reads
 * as a direction change.
 *
 * - `stuck`, reader scrolls DOWN → let go where it was (`top = lastY`), and the page carries it off.
 * - `free` and fully above the viewport, reader scrolls UP → re-park it just above the viewport
 *   (`top = lastY - headerHeight`), so the same upward scroll carries it back in.
 * - `free` and the viewport's top edge has reached it (`y <= top`) → `stuck` again. At that instant
 *   the two placements coincide, so nothing moves.
 *
 * 🛑 A step whose PAGE HEIGHT changed is layout, not the reader, and decides no DIRECTION. That case
 * is not hypothetical and not rare: Chrome's native scroll anchoring bumps `scrollY` whenever
 * content above the viewport grows, and that bump fires a `scroll` event indistinguishable from a
 * downward flick. A slow period (Y) lands its data after the header pin has expired, the charts
 * above the reader grow, and the header would let go on its own with nobody touching the screen.
 * The next event, at a settled height, decides.
 */
export function placeHeader(
  prev: HeaderPlacement,
  y: number,
  height: number,
  headerHeight: number,
): HeaderPlacement {
  const next = { ...prev, lastY: y, lastHeight: height };
  const settled = height === prev.lastHeight;
  if (prev.mode === "stuck") {
    return settled && y > prev.lastY
      ? { ...next, mode: "free", top: prev.lastY }
      : next;
  }
  let top = prev.top;
  const wasOffscreen = top + headerHeight <= prev.lastY;
  if (settled && y < prev.lastY && wasOffscreen) {
    top = Math.max(0, prev.lastY - headerHeight);
  }
  return y <= top ? { ...next, mode: "stuck", top: 0 } : { ...next, top };
}

/**
 * Below Tailwind's `sm`, where the header's two rows are a real fraction of the screen. Written as
 * a max-width query so the boundary is the same 640px `sm:` uses, with no chance of the two
 * disagreeing by a pixel at exactly 640.
 */
const NARROW_SCREEN = "(max-width: 639.98px)";

const SLIDE_IN_MS = 200;

/**
 * Lets the header scroll away with the page on the way DOWN and scroll back in on any scroll UP,
 * tracking the reader pixel for pixel (see `HeaderPlacement`). Scroll container is the window. The
 * header must be the ONLY child of a `position: sticky; top: 0` host, and `freeHostRef` an empty
 * `position: relative` sibling straight after that host; this moves the header node between the
 * two and hides whichever host is empty.
 *
 * Scrolls made by `holdScrollAnchor` (lib/charts/scroll-hold.ts) are compensation, not the reader,
 * so they only resync the baseline — and for the whole of a temporal change the header is held
 * STUCK, because the D|W|M|Y buttons the reader is aiming at live in it. `pinned` forces it stuck
 * too (e.g. while a menu hanging off the header is open).
 *
 * 🛑 While it is away the header is NOT in a sticky element, and that is deliberate. Safari 26 paints
 * a solid band behind its status bar and URL pill whenever a viewport-constrained (fixed/sticky)
 * element sits at the top edge — `visibility: hidden` and a translate do not exempt one — and lets
 * the page show through otherwise. A `relative` header parked up the page is just content.
 *
 * 🛑 And the sticky element's `position` is NEVER rewritten, which is why there are two hosts and
 * not one header with an inline `position`. Measured in the iOS 26.3 simulator: an element that
 * goes sticky → `relative`/`static` while it is rendered leaves Safari's band ORPHANED — it stays
 * for good, and even a later `display: none` does not clear it (#551 shipped exactly that). A
 * sticky element that goes `display: none` while still sticky does clear it. So the sticky host
 * stays sticky and is switched off; the header rides in a sibling that was never sticky at all.
 * Moving the node under React is safe only because the header is never unmounted or reordered on
 * its own — React removes a deleted subtree by its root, which is the host.
 *
 * 🛑 **Narrow viewports only** — from `sm` up it never lets go. The whole justification for taking
 * the header away is that on a phone its two rows permanently eat a chunk of a short screen; on a
 * desktop they cost a sliver of a tall one, and moving them buys nothing while costing the reader
 * the D|W|M|Y buttons and the dashboard switcher every time they scroll down a page. This is a
 * viewport-WIDTH question, not a touch one: a touch laptop has the room, and a phone does not stop
 * being cramped when a mouse is paired to it.
 *
 * Everything happens in effects, imperatively: the server and the first client render both emit the
 * plain sticky header, so hydration cannot mismatch, and no scroll event re-renders React.
 */
export function useHideOnScroll(
  headerRef: React.RefObject<HTMLElement | null>,
  freeHostRef: React.RefObject<HTMLElement | null>,
  pinned = false,
): void {
  const pinnedRef = useRef(pinned);
  const forceStuckRef = useRef<() => void>(() => {});

  useEffect(() => {
    pinnedRef.current = pinned;
    if (pinned) forceStuckRef.current();
  }, [pinned]);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_SCREEN);
    const pageHeight = () => document.documentElement.scrollHeight;
    const clampedY = (height: number) => {
      const maxY = Math.max(0, height - window.innerHeight);
      return Math.min(Math.max(window.scrollY, 0), maxY);
    };
    let held = false;
    let state: HeaderPlacement = {
      mode: "stuck",
      top: 0,
      lastY: window.scrollY,
      lastHeight: pageHeight(),
    };

    const stickyHost = headerRef.current?.parentElement ?? null;

    const apply = () => {
      const header = headerRef.current;
      const freeHost = freeHostRef.current;
      if (!header || !freeHost || !stickyHost) return;
      if (state.mode === "free") {
        if (header.parentElement !== freeHost) freeHost.appendChild(header);
        freeHost.style.top = `${state.top}px`;
        stickyHost.style.display = "none";
      } else {
        stickyHost.style.display = "";
        if (header.parentElement !== stickyHost) stickyHost.appendChild(header);
        freeHost.style.top = "";
      }
    };

    const forceStuck = () => {
      const header = headerRef.current;
      const height = pageHeight();
      const y = clampedY(height);
      const wasOffscreen =
        state.mode === "free" && state.top + (header?.offsetHeight ?? 0) <= y;
      state = { mode: "stuck", top: 0, lastY: y, lastHeight: height };
      apply();
      // It was nowhere on screen, so there is no position to continue from: slide it in rather
      // than have it appear.
      if (
        wasOffscreen &&
        header?.animate &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        header.animate(
          [{ transform: "translateY(-100%)" }, { transform: "none" }],
          { duration: SLIDE_IN_MS, easing: "ease-out" },
        );
      }
    };
    forceStuckRef.current = forceStuck;

    let raf = 0;
    const update = () => {
      raf = 0;
      const height = pageHeight();
      const y = clampedY(height);
      if (!mq.matches || held || pinnedRef.current || isScrollHeld()) {
        state = { ...state, lastY: y, lastHeight: height };
        return;
      }
      const next = placeHeader(
        state,
        y,
        height,
        headerRef.current?.offsetHeight ?? 0,
      );
      const moved = next.mode !== state.mode || next.top !== state.top;
      state = next;
      if (moved) apply();
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onWidth = () => {
      if (!mq.matches) forceStuck();
    };
    const unsubscribe = subscribeScrollHold((p) => {
      held = p;
      // Nothing observed during a temporal change may latch: it is stuck when the hold starts and
      // still stuck, measured from wherever the page now is, when the hold lifts.
      forceStuck();
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    mq.addEventListener("change", onWidth);
    return () => {
      window.removeEventListener("scroll", onScroll);
      mq.removeEventListener("change", onWidth);
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      forceStuckRef.current = () => {};
      // Hand React back the tree it rendered.
      state = { ...state, mode: "stuck", top: 0 };
      apply();
    };
  }, [headerRef, freeHostRef]);
}
