/**
 * Hover previews, click pins.
 *
 * The rule for what a click does to a tooltip panel, in one place. It is applied by the Sankey's
 * nodes, the Sankey's ribbons and the stacked chart's run bands — three call sites that look alike
 * and would quietly stop agreeing, which is the whole reason it is a function and not three copies
 * of an `if`.
 *
 * The model everywhere is the same pair: what is CURRENTLY SHOWN, plus a boolean saying whether it
 * is pinned. No "which one is pinned" id is needed — only one panel is ever open, so the thing shown
 * already answers that.
 */

export interface PinDecision<T> {
  /** Whether the panel is now held open independently of the pointer. */
  pinned: boolean;
  /** What to show — `null` closes the panel. */
  show: T | null;
}

export function togglePin<T>(opts: {
  /** The click landed on whatever is currently shown (rather than on a different node/run). */
  isSameTarget: boolean;
  /** Something is currently pinned. */
  isPinned: boolean;
  /** The freshly-resolved panel contents for the clicked target. */
  target: T;
  /**
   * There is no hover to fall back to.
   *
   * Releasing a pin with a MOUSE leaves the pointer sitting on the very thing that was pinned, so
   * the panel should drop back to a hover preview — blanking it would read as the click having
   * closed something for good, and the next mouse movement would pop it straight back anyway. On
   * touch there is no pointer at rest, so releasing closes.
   */
  isTouch: boolean;
}): PinDecision<T> {
  if (opts.isPinned && opts.isSameTarget) {
    return { pinned: false, show: opts.isTouch ? null : opts.target };
  }
  return { pinned: true, show: opts.target };
}
