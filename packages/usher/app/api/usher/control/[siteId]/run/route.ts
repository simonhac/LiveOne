/** Thin Next.js wrapper — all logic lives in core/control-api.ts (see its header for why). */
import { handleRunGet, handleRunPost } from "@/core/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await ctx.params;
  return handleRunPost(req, siteId);
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await ctx.params;
  return handleRunGet(req, siteId);
}
