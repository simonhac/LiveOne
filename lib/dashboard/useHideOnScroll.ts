"use client";

import { useEffect, useRef } from "react";
import { isScrollHeld, subscribeScrollHold } from "@/lib/charts/scroll-hold";

/**
 * Where the header is. Two states:
 *
 * - `stuck` — inside the sticky host (`position: sticky; top: 0`). Pinned to the top of the
 *   viewport until the page scrolls past `top`, its ARMING POINT; over the next `travel` px a
 *   scroll-driven CSS animation on the host translates it up and out. The leave is therefore a pure
 *   function of scroll offset that was set up BEFORE the reader moved — no JS runs at the moment it
 *   starts, which is the only way it can start from rest (see `placeHeader`).
 * - `free` — inside the free host (`position: relative; top: <top>px`): an ordinary part of the
 *   DOCUMENT, parked at page offset `top`. The page carries it at 1px per px and the same kind of
 *   animation adds the rest of {@link HEADER_SPEED}. This is where it lives while it is AWAY, and
 *   how it comes back in.
 */
export interface HeaderPlacement {
  mode: "stuck" | "free";
  /** `free`: page offset of the header's top edge. `stuck`: the scroll offset it starts leaving at. */
  top: number;
  /** Scroll offset at the previous step, and the page height it was read at. */
  lastY: number;
  lastHeight: number;
}

/**
 * One scroll step → the next placement. Pure, so the logic is testable without a DOM.
 *
 * `travel` is how much SCROLL takes the header from fully shown to fully gone: its own height at
 * 1px per px, half that at {@link HEADER_SPEED}.
 *
 * `y` must already be clamped to `[0, maxY]` — iOS rubber-banding past either end otherwise reads
 * as a direction change.
 *
 * `stuck` (armed at `top`):
 * - `y < top` — the reader has scrolled UP past the arming point: re-arm at `y`, so a turn back
 *   down starts the leave from wherever they turned. A late re-arm only delays the leave a hair.
 * - `top <= y < top + travel` — mid-leave, and CSS owns it. Nothing to do, in either direction.
 * - `y >= top + travel` — fully out of sight: hand it to the free host, parked where it is. This
 *   swap is what Safari's top band needs (see `useHideOnScroll`), and it is invisible, so it does
 *   not matter how late it runs.
 *
 * `free`:
 * - fully above the viewport, reader scrolls UP → re-park it just out of sight (`top = y - travel`),
 *   so the rest of that upward scroll carries it back in.
 * - the viewport's top edge has reached it (`y <= top`) → `stuck` again, armed at `y`. The two
 *   placements coincide there, so nothing moves.
 *
 * 🛑 Why the leave is armed in advance rather than started by this function. A touch scroll runs
 * on the compositor, AHEAD of the main thread: by the time a scroll event has been delivered and
 * a release applied, the page is already some px further on, and a header released "now" lands
 * that far into its journey — doubled at 2px per px. It read as a big jump on the way down, and no
 * choice of release point fixes it, because the lag is in when JS runs at all.
 *
 * 🛑 A step whose PAGE HEIGHT changed is layout, not the reader. Chrome's native scroll anchoring
 * bumps `scrollY` whenever content above the viewport grows, which is indistinguishable from a
 * downward flick — and an armed header would leave on it without asking. So such a step carries
 * a stuck header's arming point along with the page (its progress is untouched), and never
 * re-parks a free one. The hook also runs a step whenever the page RESIZES, not only on scroll, so
 * that a height change with no scroll event cannot make the reader's next real step look like one.
 *
 * `scrollDriven: false` is the browser without scroll timelines: nothing can be armed, so a stuck
 * header is released by JS on a downward step, at 1px per px, as it always was.
 */
export function placeHeader(
  prev: HeaderPlacement,
  y: number,
  height: number,
  travel: number,
  scrollDriven = true,
): HeaderPlacement {
  const next = { ...prev, lastY: y, lastHeight: height };
  const settled = height === prev.lastHeight;
  if (prev.mode === "stuck") {
    if (!scrollDriven) {
      return settled && y > prev.lastY
        ? { ...next, mode: "free", top: y }
        : next;
    }
    // Layout moved the page, so move the arming point WITH it: the header keeps exactly the
    // progress it had, neither leaving on the bump nor snapping back from a leave already begun.
    if (!settled) {
      return { ...next, top: Math.max(0, prev.top + (y - prev.lastY)) };
    }
    if (y < prev.top) return { ...next, top: y };
    return y >= prev.top + travel ? { ...next, mode: "free" } : next;
  }
  let top = prev.top;
  // Strictly BEYOND just-out-of-sight: a header this function parked one step ago sits at exactly
  // `lastY - travel`, and re-parking that one on every upward step would hold it at the threshold
  // for ever instead of letting it in.
  const wasOffscreen = top + travel < prev.lastY - 0.5;
  if (settled && y < prev.lastY && wasOffscreen) {
    top = Math.max(0, y - travel);
  }
  return y <= top ? { ...next, mode: "stuck", top: y } : { ...next, top };
}

/**
 * Below Tailwind's `sm`, where the header's two rows are a real fraction of the screen. Written as
 * a max-width query so the boundary is the same 640px `sm:` uses, with no chance of the two
 * disagreeing by a pixel at exactly 640.
 */
const NARROW_SCREEN = "(max-width: 639.98px)";

const SLIDE_IN_MS = 200;

/**
 * How many px the header moves per px of scroll while it is leaving or returning.
 *
 * The motion is a CSS scroll-driven animation on whichever host holds the header
 * (`.header-scroll-host`, globals.css): a `translateY` tied to the root scroller over
 * `[top, top + travel]`. The sticky host contributes no motion of its own, so there the animation
 * is the whole journey (`-height`); the free host rides the page at 1px per px, so there it is the
 * remainder. Either way it is a pure function of scroll offset — reversible mid-way with nothing
 * to re-anchor, and no per-frame JS to fall behind a fling. A browser without `animation-timeline`
 * gets 1px per px and a JS release.
 */
const HEADER_SPEED = 2;
const scrollTimelineSupported = () =>
  typeof CSS !== "undefined" &&
  CSS.supports("animation-timeline: scroll()") &&
  CSS.supports("animation-range: 0px 1px");

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
    // Both ways: pinning brings it back, and un-pinning has to re-arm it where the page now is.
    forceStuckRef.current();
  }, [pinned]);

  useEffect(() => {
    const mq = window.matchMedia(NARROW_SCREEN);
    const pageHeight = () => document.documentElement.scrollHeight;
    const clampedY = (height: number) => {
      const maxY = Math.max(0, height - window.innerHeight);
      return Math.min(Math.max(window.scrollY, 0), maxY);
    };
    let held = false;
    const scrollDriven = scrollTimelineSupported();
    const speed = scrollDriven ? HEADER_SPEED : 1;
    /** Shown no matter what: wide screen, a menu open, or a temporal change in flight. */
    const locked = () => !mq.matches || held || pinnedRef.current;
    const travelOf = (header: HTMLElement | null) =>
      (header?.offsetHeight ?? 0) / speed;
    let state: HeaderPlacement = {
      mode: "stuck",
      top: Math.max(0, window.scrollY),
      lastY: window.scrollY,
      lastHeight: pageHeight(),
    };

    const stickyHost = headerRef.current?.parentElement ?? null;

    const drive = (host: HTMLElement, start: number, away: number) => {
      host.style.setProperty("--header-range-start", `${start}px`);
      host.style.setProperty(
        "--header-range-end",
        `${start + travelOf(headerRef.current)}px`,
      );
      host.style.setProperty("--header-away", `${away}px`);
    };

    const apply = () => {
      const header = headerRef.current;
      const freeHost = freeHostRef.current;
      if (!header || !freeHost || !stickyHost) return;
      if (state.mode === "free") {
        if (header.parentElement !== freeHost) freeHost.appendChild(header);
        freeHost.style.top = `${state.top}px`;
        // The page supplies 1px per px; the animation supplies the other `speed - 1`.
        drive(freeHost, state.top, -(speed - 1) * travelOf(header));
        stickyHost.style.display = "none";
      } else {
        stickyHost.style.display = "";
        if (header.parentElement !== stickyHost) stickyHost.appendChild(header);
        freeHost.style.top = "";
        // Sticky supplies no motion, so the animation is the whole journey.
        drive(stickyHost, state.top, -header.offsetHeight);
        // 🛑 Locked means NO animation, not a zero-length one: any `transform`, even a null one,
        // makes the host the containing block for `position: fixed` descendants, and the dashboard
        // switcher's full-screen click-catcher lives in here — it would shrink to the header.
        stickyHost.style.animationName = locked() ? "none" : "";
      }
    };

    const forceStuck = () => {
      const header = headerRef.current;
      const height = pageHeight();
      const y = clampedY(height);
      const wasOffscreen =
        state.mode === "free" && state.top + travelOf(header ?? null) <= y;
      state = { mode: "stuck", top: y, lastY: y, lastHeight: height };
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
      if (locked() || isScrollHeld()) {
        state = { ...state, lastY: y, lastHeight: height };
        // Keep a stuck header armed at the reader, so that whenever this lifts the leave starts
        // from where they are rather than from wherever they were when it began.
        if (state.mode === "stuck" && state.top !== y) {
          state = { ...state, top: y };
          apply();
        }
        return;
      }
      const next = placeHeader(
        state,
        y,
        height,
        travelOf(headerRef.current),
        scrollDriven,
      );
      const moved = next.mode !== state.mode || next.top !== state.top;
      state = next;
      if (moved) apply();
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onWidth = () => forceStuck();
    const unsubscribe = subscribeScrollHold((p) => {
      held = p;
      // Nothing observed during a temporal change may latch: it is stuck when the hold starts and
      // still stuck, measured from wherever the page now is, when the hold lifts.
      forceStuck();
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    mq.addEventListener("change", onWidth);
    // See `placeHeader` on layout steps: absorb a height change when it happens.
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(onScroll);
    resize?.observe(document.body);
    apply(); // arm it where the page already is
    return () => {
      window.removeEventListener("scroll", onScroll);
      mq.removeEventListener("change", onWidth);
      resize?.disconnect();
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      forceStuckRef.current = () => {};
      // Hand React back the tree it rendered, with nothing armed.
      held = true;
      state = { ...state, mode: "stuck" };
      apply();
    };
  }, [headerRef, freeHostRef]);
}
