/** One-shot JSON of the inspector view (for debugging / non-SSE clients). */
import { getUsherView } from "@/state/view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(getUsherView());
}
