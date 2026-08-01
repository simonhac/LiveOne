import localFont from "next/font/local";

/**
 * TT Interphases Pro - Amber Electric's brand font
 * Weights: 400 (Regular), 700 (Bold)
 */
export const ttInterphases = localFont({
  src: [
    {
      path: "../../public/fonts/TT_Interphases_Pro_Trial_Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../public/fonts/TT_Interphases_Pro_Trial_Bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-tt-interphases",
  /**
   * 🛑 A LOCAL font gets no automatic size-adjusted fallback from `next/font` — that is only
   * generated for Google fonts, whose metrics next knows. Without these, every Amber-styled surface
   * (Tile, AmberSmallCard, AmberNow, the stat cards, LoadProvenanceCard) painted in the system font
   * and then re-laid-out on swap. `adjustFontFallback` names the face whose metrics to scale the
   * fallback to, so the pre-swap text occupies the same box as the post-swap text.
   */
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
  adjustFontFallback: "Arial",
});
