/**
 * GET /api/cli-auth/tokens — the caller's own CLI tokens.
 *
 * Reachable with either a Clerk session or a CLI token (it is in isCliTokenRoute), so `auth list`
 * works from the CLI. Never returns a hash or a secret: `describeTokens` strips them.
 *
 * Live tokens only unless `?all=true` — the default answers "what can currently access my account",
 * which is the question worth being unambiguous about.
 */
import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAuth } from "@/lib/api-auth";
import { describeTokens, type UserLike } from "@/lib/cli-auth/tokens";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const includeDead = new URL(request.url).searchParams.get("all") === "true";
  const client = await clerkClient();
  const user = (await client.users.getUser(auth.userId)) as unknown as UserLike;
  return NextResponse.json({
    tokens: describeTokens(user, new Date(), { includeDead }),
  });
}
