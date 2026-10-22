"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Shrink a single line of text until it fits its box, down to `minPx`; below that, ellipsis.
 *
 * Why not just ellipsis: a tile's hero IS the tile — "Flat batt…" hides the one word that says what
 * is wrong, while the same words two sizes down still read at a glance. Why not just shrink: a long
 * enough string would shrink to nothing, and a 9px hero is not a hero. So shrink first, to a floor
 * that is still clearly the biggest thing on the tile, and only then truncate.
 *
 * The element's CSS decides the base size (the hero's container-query steps), so every pass starts
 * by clearing the override and measuring at that size — a tile that WIDENS gets its full size back.
 * Watches the PARENT's size, not the element's: resizing the element is exactly what this does, so
 * observing it would loop.
 */
export function useFitText(
  ref: RefObject<HTMLElement | null>,
  minPx: number,
  /** Re-fit when these change — the text itself, chiefly. */
  deps: readonly unknown[],
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    const fit = () => {
      el.style.fontSize = "";
      el.style.textOverflow = "";
      el.style.overflow = "";
      const available = el.clientWidth;
      const needed = el.scrollWidth;
      if (available <= 0 || needed <= available) return;
      const base = parseFloat(getComputedStyle(el).fontSize);
      // Glyph advance scales linearly with font-size, so one proportional step lands within a pixel;
      // floor it so rounding can never leave the last glyph a sub-pixel over.
      const px = Math.max(minPx, Math.floor((base * available) / needed));
      el.style.fontSize = `${px}px`;
      if (px === minPx && el.scrollWidth > el.clientWidth) {
        el.style.overflow = "hidden";
        el.style.textOverflow = "ellipsis";
      }
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    // Web fonts land after first paint and change every glyph's width.
    document.fonts?.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, minPx, ...deps]);
}
