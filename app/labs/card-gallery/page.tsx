import { notFound } from "next/navigation";
import CardGallery from "./CardGallery";

/**
 * Internal card gallery — renders every pure-presentational dashboard card at many sizes for
 * visual inspection. Public on dev + Vercel preview only (allow-listed in lib/route-matchers.ts
 * for non-prod); this guard makes the page itself dead in production as defense-in-depth.
 */
export default function CardGalleryPage() {
  if (process.env.VERCEL_ENV === "production") {
    notFound();
  }
  return <CardGallery />;
}
