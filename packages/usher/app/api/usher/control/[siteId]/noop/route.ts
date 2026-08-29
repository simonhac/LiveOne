/**
 * The `noop` probe — exercises the full control chain, writes nothing. See core/control-api.ts.
 * GET and POST behave identically (GET for convenience with the passkey in a header).
 */
import { handleNoopPost } from "@/core/control-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await ctx.params;
  return handleNoopPost(req, siteId);
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ siteId: string }> },
): Promise<Response> {
  const { siteId } = await ctx.params;
  return handleNoopPost(req, siteId);
}
