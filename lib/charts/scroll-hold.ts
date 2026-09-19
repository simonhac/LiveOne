/**
 * Hold the reader's place across a temporal change (D|W|M|Y, older/newer).
 *
 * A period switch is a shallow `pushState`, so nothing remounts, but several cards are as tall as
 * their DATA (the runs list, conditional tile rows, the stacked-chart tables). When one above the
 * fold changes height, everything below it moves. Chrome papers over that with CSS scroll
 * anchoring; iOS Safari has none, which is why the jump is so visible on a phone.
 *
 * So: before the URL changes, pick the element the reader is looking at (`[data-scroll-anchor]`,
 * the smallest one straddling the line under the header), remember where it sits on screen, and for
 * the next ~2s scroll by however far it has drifted. Where the browser already anchors natively the
 * drift is 0 and this does nothing, so the two never fight. Any user scroll intent releases it.
 *
 * Anchors are remembered by KEY (+ index among same-key elements), not by node: the sankey
 * placeholder ↔ real block swap replaces the element mid-hold.
 */

const ANCHOR_ATTR = "data-scroll-anchor";
const HOLD_MS = 2000;
const RELEASE_EVENTS = ["wheel", "touchstart", "keydown"] as const;

interface Box {
  top: number;
  bottom: number;
}

/**
 * The index of the anchor to hold: the SMALLEST box straddling `line` (innermost, so a 1570px
 * charts card defers to the sankey block inside it), else the first box starting below `line`.
 * -1 when there is nothing to hold. Zero-height boxes (hidden elements) never qualify.
 */
export function pickAnchor(boxes: readonly Box[], line: number): number {
  let best = -1;
  let bestH = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const { top, bottom } = boxes[i];
    const h = bottom - top;
    if (h <= 0) continue;
    if (top <= line && bottom > line && h < bestH) {
      best = i;
      bestH = h;
    }
  }
  if (best !== -1) return best;
  let firstBelow = -1;
  for (let i = 0; i < boxes.length; i++) {
    const { top, bottom } = boxes[i];
    if (bottom - top <= 0 || top < line) continue;
    if (firstBelow === -1 || top < boxes[firstBelow].top) firstBelow = i;
  }
  return firstBelow;
}

interface Hold {
  key: string;
  nth: number;
  top: number;
  until: number;
  raf: number;
  minHeightEl: HTMLElement | null;
  prevMinHeight: string;
}

let hold: Hold | null = null;
const listeners = new Set<(held: boolean) => void>();

let pinTimer: ReturnType<typeof setTimeout> | null = null;
let pinned = false;

/**
 * Observe whether a temporal change is in flight. The hide-on-scroll header subscribes and stays
 * SHOWN throughout: switching D|W|M|Y must never slide the header away — the reader is aiming at
 * those very buttons.
 *
 * It is a signal of its own rather than "is a hold running" for two reasons. A hold may not start
 * at all (already at the top of the page, or nothing to anchor to) and the header still must not
 * move; and the hold's LAST compensating scroll can be PROCESSED a frame after the hold releases —
 * the header's scroll listener is rAF-throttled — which would read as the reader scrolling down.
 * Hence the grace period below.
 */
export function subscribeScrollHold(cb: (pinned: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Grace after the hold's deadline, to outlast one rAF-throttled scroll callback. */
const PIN_GRACE_MS = 300;

function announce(next: boolean) {
  if (next === pinned) return;
  pinned = next;
  for (const cb of listeners) cb(next);
}

/** Pin for one temporal change; re-arming extends it, matching the hold's own deadline. */
function pin() {
  announce(true);
  if (pinTimer) clearTimeout(pinTimer);
  pinTimer = setTimeout(() => {
    pinTimer = null;
    announce(false);
  }, HOLD_MS + PIN_GRACE_MS);
}

function release() {
  if (!hold) return;
  cancelAnimationFrame(hold.raf);
  if (hold.minHeightEl) hold.minHeightEl.style.minHeight = hold.prevMinHeight;
  for (const ev of RELEASE_EVENTS) window.removeEventListener(ev, release);
  delete document.documentElement.dataset.scrollHold;
  hold = null;
}

function resolve(key: string, nth: number): Element | null {
  const all = document.querySelectorAll(
    `[${ANCHOR_ATTR}="${CSS.escape(key)}"]`,
  );
  return all[nth] ?? all[0] ?? null;
}

function tick() {
  if (!hold) return;
  // Correct BEFORE checking the deadline: a backgrounded tab gets no frames at all, so its first
  // frame can arrive after the deadline, and it still owes the reader one correction.
  const el = resolve(hold.key, hold.nth);
  if (el) {
    const delta = el.getBoundingClientRect().top - hold.top;
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
  }
  if (performance.now() > hold.until) {
    release();
    return;
  }
  hold.raf = requestAnimationFrame(tick);
}

/** The y (viewport px) just under the sticky dashboard header, or 0 when it is slid away. */
function headerLine(): number {
  const header = document.querySelector("header");
  if (!header) return 0;
  const bottom = header.getBoundingClientRect().bottom;
  return bottom > 0 ? bottom : 0;
}

/**
 * Call immediately BEFORE the URL change that will reshape the page. Re-calling while a hold is
 * active just extends it — the reader's anchor is the one they had before the FIRST click, which is
 * still where they are looking.
 */
export function holdScrollAnchor(): void {
  if (typeof window === "undefined") return;
  pin(); // unconditionally: the header must stay put even when there is nothing to anchor
  if (hold) {
    hold.until = performance.now() + HOLD_MS;
    return;
  }
  if (window.scrollY === 0) return; // nothing above the reader to move

  const els = Array.from(document.querySelectorAll(`[${ANCHOR_ATTR}]`));
  const rects = els.map((el) => el.getBoundingClientRect());
  const idx = pickAnchor(rects, headerLine());
  if (idx === -1) return;
  const el = els[idx];
  const key = el.getAttribute(ANCHOR_ATTR)!;
  const nth = els
    .filter((e) => e.getAttribute(ANCHOR_ATTR) === key)
    .indexOf(el);

  // Pin the page's height for the hold, so a SHORTER period can't clamp the scroll position out
  // from under the reader before the compensation gets a chance to run.
  const main = document.querySelector("main") as HTMLElement | null;
  const minHeightEl = main;
  const prevMinHeight = main?.style.minHeight ?? "";
  if (main) main.style.minHeight = `${main.offsetHeight}px`;

  hold = {
    key,
    nth,
    top: rects[idx].top,
    until: performance.now() + HOLD_MS,
    raf: 0,
    minHeightEl,
    prevMinHeight,
  };
  document.documentElement.dataset.scrollHold = "";
  // Registered after the tap that triggered this, so that tap can't release its own hold.
  for (const ev of RELEASE_EVENTS)
    window.addEventListener(ev, release, { passive: true });
  hold.raf = requestAnimationFrame(tick);
}

/** True while a hold is compensating — its scrolls are not the reader's. */
export function isScrollHeld(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.scrollHold !== undefined
  );
}
