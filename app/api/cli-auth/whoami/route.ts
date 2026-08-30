/**
 * GET /api/cli-auth/whoami — the server side of the CLI's `target:` line.
 *
 * The direct-database transport prints `target: <db> as <role> @ <host>` before doing anything,
 * and that line IS the prod/dev check. Over HTTP the equivalent question is "which deployment am I
 * talking to, as whom, and which database is behind it" — this answers it in one call.
 *
 * It exists because of a specific hazard: a Vercel PREVIEW authenticates against the PRODUCTION
 * Clerk instance while pointing at the liveone-dev database. A prod-minted CLI token therefore
 * works against a preview, and without this line an operator cannot tell from the response whether
 * a write is about to land in prod or dev.
 */
import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { requireAuth } from "@/lib/api-auth";

/** Host only — never the credential embedded in a connection string. */
function dbHost(): string {
  const raw = process.env.PLANETSCALE_DATABASE_URL ?? process.env.DB_HOST ?? "";
  if (!raw) return "unknown";
  try {
    return new URL(raw).host;
  } catch {
    return raw.includes("@") ? raw.split("@").pop()! : raw;
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const client = await clerkClient();
  const user = await client.users.getUser(auth.userId);

  return NextResponse.json({
    userId: auth.userId,
    email: user.emailAddresses[0]?.emailAddress ?? null,
    isAdmin: auth.isAdmin,
    vercelEnv: process.env.VERCEL_ENV ?? "development",
    // The publishable key's prefix distinguishes the two Clerk instances without exposing a secret.
    clerkInstance: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith(
      "pk_live_",
    )
      ? "production"
      : "development",
    dbHost: dbHost(),
    buildSha: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
}
