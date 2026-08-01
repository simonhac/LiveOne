import { Suspense } from "react";
import { notFound } from "next/navigation";
import ChartGallery from "./ChartGallery";

/**
 * Internal chart gallery — renders every time-series chart from deterministic fixtures, as the
 * screenshot target for `e2e/charts.spec.ts`. Public on dev + Vercel preview only (allow-listed in
 * lib/route-matchers.ts for non-prod); this guard makes the page itself dead in production as
 * defense-in-depth. Same shape as ../card-gallery.
 */
export default function ChartGalleryPage() {
  if (process.env.VERCEL_ENV === "production") {
    notFound();
  }
  // useSearchParams() needs a Suspense boundary to avoid opting the whole route into CSR bailout.
  return (
    <Suspense fallback={null}>
      <ChartGallery />
    </Suspense>
  );
}
