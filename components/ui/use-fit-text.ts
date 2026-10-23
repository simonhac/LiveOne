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

/**
 * Shrink a ROW of side-by-side values together, so they never collide: one font size for all of
 * them, down to `minPx` — the OE grid tile's "$110/MWh" beside "618g/kWh" on a phone.
 *
 * Why together rather than each on its own (`useFitText`): two neighbours at different sizes read as
 * two different kinds of number, and which one is "too long" is not a fact about either value but
 * about the pair. So the row fits when the values' natural widths plus the gaps between the row's
 * columns fit the row, and when they don't, every value takes the same proportional step.
 *
 * Targets are the row's `[data-fit-value]` elements (`TrendRow` marks its value span). `Value` sizes
 * its prefix and unit in `em`, so "$", "/MWh" and "g/kWh" shrink with the number. No ellipsis floor:
 * a clipped price is worse than a small one.
 */
export function useFitRow(
  ref: RefObject<HTMLElement | null>,
  minPx: number,
  /** Re-fit when these change — the values, chiefly. */
  deps: readonly unknown[],
): void {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;

    const fit = () => {
      const targets = Array.from(
        row.querySelectorAll<HTMLElement>("[data-fit-value]"),
      );
      for (const t of targets) t.style.fontSize = "";
      // Hidden (display:none below a breakpoint) measures 0 — leave it for when it shows.
      if (targets.length === 0 || row.clientWidth <= 0) return;
      const columns = row.children.length;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const available = row.clientWidth - gap * Math.max(0, columns - 1);
      const needed = targets.reduce((sum, t) => sum + t.scrollWidth, 0);
      if (needed <= available) return;
      const base = parseFloat(getComputedStyle(targets[0]).fontSize);
      // Floor, as in useFitText: rounding must never leave the last glyph a sub-pixel over.
      const px = Math.max(minPx, Math.floor((base * available) / needed));
      for (const t of targets) t.style.fontSize = `${px}px`;
    };

    fit();
    // Observing the row is safe here: its WIDTH is the tile's, and only its height follows the font.
    const ro = new ResizeObserver(fit);
    ro.observe(row);
    document.fonts?.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, minPx, ...deps]);
}
