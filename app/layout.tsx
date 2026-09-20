import type { Metadata, Viewport } from "next";
import { DM_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import Providers from "./providers";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  // Preloaded. It was off ("to avoid unused preload warnings"), which meant the body font was
  // discovered only once the CSS had parsed — so every page painted in the fallback first and then
  // re-laid-out on swap. `next/font` also generates a size-adjusted fallback face for a Google
  // font, so the swap itself is metric-compatible; the preload is what removes the delay before it.
  preload: true,
});

export const metadata: Metadata = {
  title: process.env.NODE_ENV === "development" ? "LiveOne — Dev" : "LiveOne",
  description: "Real-time solar energy monitoring and analytics",
};

/**
 * For browsers that still read it. Safari 26 does NOT: it takes the colour of the band behind its
 * status bar and URL pill from a fixed/sticky element at the top edge, else from the body
 * background — and paints a solid band at all only while such an element is there (see
 * `useHideOnScroll`). Deliberately no `viewport-fit=cover`, which the pages that paint through
 * that band do not use either, and which was tried on the phone and changed nothing.
 */
export const viewport: Viewport = { themeColor: "#000000" };

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isDev = process.env.NODE_ENV === "development";

  return (
    <ClerkProvider>
      <html lang="en">
        <body className={dmSans.className}>
          {isDev && (
            <div className="fixed top-0 left-0 right-0 h-1 bg-orange-500 z-[9999]" />
          )}
          <Providers>{children}</Providers>
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
