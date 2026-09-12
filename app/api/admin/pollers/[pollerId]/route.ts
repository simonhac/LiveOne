import { NextRequest } from "next/server";
import { adminPollers } from "@/lib/collectors/api";
async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ pollerId: string }> },
) {
  return adminPollers(req, (await ctx.params).pollerId);
}
export { handle as GET, handle as PATCH, handle as DELETE };
