"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The `?debug` container-size badge two tiles carry, in one place.
 *
 * `AmberSmallCard` and `TeslaSmallCard` both step their layout on container-query breakpoints
 * (`@[180px]`), and both grew the same instrument for seeing which side of one they are on: a
 * `?debug`-gated corner badge reading the tile's CONTENT box. The two implementations were
 * identical bar their comments — the same URL check, the same initial measure, the same
 * `ResizeObserver` — and `containerSize` was consumed by nothing but the badge in either file.
 *
 * 🛑 Content-box, not border-box, and that is the whole point. `getBoundingClientRect()` is the
 * border box, but container queries resolve against the CONTENT box, so a badge reading the former
 * would disagree with the `@[180px]:` step it exists to explain — by exactly the padding, at
 * exactly the width where you are squinting at the boundary. Hence the padding/border subtraction
 * on the first measure, and `contentRect` (which is already content-box) thereafter.
 *
 * `bg-red-500` stays a literal here, and this file carries the last entry in the colour gate's
 * EXEMPTIONS: a dev-only affordance is not a `danger` state, and minting a `--color-debug` would
 * put "no meaning" in a vocabulary whose whole premise is that every colour has one.
 */
export function useDebugSizeBadge() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(new URLSearchParams(window.location.search).has("debug"));
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const px =
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth);
    const py =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    setSize({
      width: Math.round(rect.width - px),
      height: Math.round(rect.height - py),
    });

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          width: Math.round(entry.contentRect.width),
          height: Math.round(entry.contentRect.height),
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return {
    /** Hand this to `<TileSurface rootRef>` — the element whose content box is measured. */
    rootRef,
    /** Render inside that surface. `null` unless `?debug` is in the URL. */
    badge: show ? (
      <div className="absolute top-0 right-0 bg-red-500 text-ink text-[10px] px-1 rounded-bl z-50">
        {size.width}w {size.height}h
      </div>
    ) : null,
  };
}
