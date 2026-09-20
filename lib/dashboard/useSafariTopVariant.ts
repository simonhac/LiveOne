"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 🚧 TEMPORARY — delete with the `safariTop` experiment (see SafariTopSwitcher.tsx).
 *
 * On an iPhone running Safari 26, a ~105 css px band at the top of the dashboard (status bar +
 * minimised URL pill) paints IN FRONT of the cards with a hard edge. It does not reproduce here: no
 * simulator, and previews are SSO-walled. So the candidate fixes ship together behind `?safariTop=`
 * and are chosen on the phone, against prod; a follow-up PR keeps the winner and deletes all of this.
 *
 * - `off` — today's behaviour, unchanged. Also what any unrecognised value means.
 * - `a` — the header stops being `sticky` while it is hidden, so there is no top-edge sticky element
 *   at all (the leading suspect: #547 moved the header's PAINT to an absolute child, but the sticky
 *   box itself remained). Free of layout risk — a sticky element occupies its normal flow slot, so
 *   swapping it to `relative` moves nothing.
 * - `b` — `a` plus `viewport-fit=cover`. `app/layout.tsx` exports no `viewport`, so this rewrites
 *   Next's default `<meta name="viewport">` at runtime and restores the original string on the way out.
 * - `c` — drops the black root canvas (`globals.css`). Purely diagnostic: does the band's colour follow?
 * - `d` — header never sticky on a narrow screen and never hidden on scroll. Settles whether `sticky`
 *   is implicated at all, at the cost of a permanently-parked header.
 *
 * The switcher, and any effect at all, requires `?safariTop` to be PRESENT in the URL. A normal
 * visitor never sees it.
 *
 * 🛑 Put it on the CANONICAL dashboard url (`/dashboard/<owner>/<slug>?safariTop=`). Bare
 * `/dashboard` is a server `redirect()` to that path and carries no query with it, so the flag is
 * silently gone before anything here runs.
 */
export const SAFARI_TOP_VARIANTS = ["off", "a", "b", "c", "d"] as const;

export type SafariTopVariant = (typeof SAFARI_TOP_VARIANTS)[number];

function asVariant(raw: string | null): SafariTopVariant {
  return (SAFARI_TOP_VARIANTS as readonly string[]).includes(raw ?? "")
    ? (raw as SafariTopVariant)
    : "off";
}

export interface SafariTopState {
  /** `?safariTop` was present at mount — render the switcher, apply the variant. */
  enabled: boolean;
  variant: SafariTopVariant;
  select: (next: SafariTopVariant) => void;
}

export function useSafariTopVariant(): SafariTopState {
  const [enabled, setEnabled] = useState(false);
  const [variant, setVariant] = useState<SafariTopVariant>("off");

  // Read in a mount effect, not during render: the server has no URL and the first client render
  // must match it, so both start at `off`/disabled and adopt the real answer a tick later.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("safariTop")) return;
    setEnabled(true);
    setVariant(asVariant(params.get("safariTop")));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const html = document.documentElement;
    html.setAttribute("data-safari-top", variant);
    // Captured per-variant so the cleanup restores whatever was there before THIS variant, however
    // many times you flip back and forth.
    const meta = document.querySelector('meta[name="viewport"]');
    const original = meta?.getAttribute("content") ?? null;
    if (meta && original !== null && variant === "b") {
      if (!original.includes("viewport-fit")) {
        meta.setAttribute("content", `${original}, viewport-fit=cover`);
      }
    }
    return () => {
      html.removeAttribute("data-safari-top");
      if (meta && original !== null) meta.setAttribute("content", original);
    };
  }, [enabled, variant]);

  const select = useCallback((next: SafariTopVariant) => {
    setVariant(next);
    // Copy-then-set, so `period`/`start`/`end` (and `access`) survive — the same discipline as
    // `encodeRangeToParams`. `safariTop=` empty keeps the switcher on screen across a reload.
    const params = new URLSearchParams(window.location.search);
    params.set("safariTop", next === "off" ? "" : next);
    window.history.replaceState(
      null,
      "",
      `?${params.toString()}${window.location.hash}`,
    );
  }, []);

  return { enabled, variant, select };
}
