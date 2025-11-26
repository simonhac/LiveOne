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
});
