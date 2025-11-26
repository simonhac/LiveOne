import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "./auth-utils";
import { SystemsManager, SystemWithPolling } from "./systems-manager";
import { db } from "./db";
import { userSystems } from "./db/schema";
import { eq, and } from "drizzle-orm";

// Authorization result with context
export interface AuthContext {
  userId: string | null;
  isAdmin: boolean;
  isCron: boolean;
  isClaudeDev: boolean;
}

// Successful auth result (userId is guaranteed to be defined)
export interface AuthenticatedContext extends AuthContext {
  userId: string;
}

// System access result
export interface SystemAuthContext extends AuthenticatedContext {
  system: SystemWithPolling;
  isOwner: boolean;
  isViewer: boolean;
  canRead: boolean;
  canWrite: boolean;
}

// Error response helper
function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function forbidden(message = "Forbidden") {
  return NextResponse.json({ error: message }, { status: 403 });
}

// Check if this is a Claude development request
function isClaudeDevRequest(request: NextRequest): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    request.headers.get("x-claude") === "true"
  );
}

// Check if this is a valid cron request
function isCronRequest(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  return (
    !!process.env.CRON_SECRET &&
    authHeader === `Bearer ${process.env.CRON_SECRET}`
  );
}

// Base auth check - returns context
export async function getAuthContext(
  request: NextRequest,
): Promise<AuthContext> {
  const isClaudeDev = isClaudeDevRequest(request);
  const isCron = isCronRequest(request);

  // Claude-dev bypasses normal auth
  if (isClaudeDev) {
    return { userId: "claude-dev", isAdmin: true, isCron, isClaudeDev };
  }

  const { userId } = await auth();
  const isAdmin = userId ? await isUserAdmin(userId) : false;

  return { userId, isAdmin, isCron, isClaudeDev };
}

// ===== Authorization Functions =====

// Require authentication only
export async function requireAuth(
  request: NextRequest,
): Promise<AuthenticatedContext | NextResponse> {
  const ctx = await getAuthContext(request);
  if (!ctx.userId) {
    return unauthorized();
  }
  return ctx as AuthenticatedContext;
}

// Require admin access
export async function requireAdmin(
  request: NextRequest,
): Promise<AuthenticatedContext | NextResponse> {
  const ctx = await getAuthContext(request);
  if (!ctx.userId) {
    return unauthorized();
  }
  if (ctx.isAdmin) {
    return ctx as AuthenticatedContext;
  }
  return forbidden("Admin access required");
}

// Require cron or admin access
export async function requireCronOrAdmin(
  request: NextRequest,
): Promise<AuthContext | NextResponse> {
  const ctx = await getAuthContext(request);
  if (ctx.isCron || ctx.isAdmin || ctx.isClaudeDev) {
    return ctx;
  }
  if (!ctx.userId) {
    return unauthorized();
  }
  return forbidden("Cron or admin access required");
}

// Require system access (owner, viewer, or admin)
export async function requireSystemAccess(
  request: NextRequest,
  systemId: number,
  options: { requireWrite?: boolean } = {},
): Promise<SystemAuthContext | NextResponse> {
  const ctx = await getAuthContext(request);

  // Get system
  const systemsManager = SystemsManager.getInstance();
  const system = await systemsManager.getSystem(systemId);
  if (!system) {
    return NextResponse.json({ error: "System not found" }, { status: 404 });
  }

  // Check access levels
  const isOwner = ctx.userId === system.ownerClerkUserId;
  let isViewer = false;

  if (ctx.userId && !isOwner && !ctx.isAdmin) {
    // Check userSystems table for viewer access
    const viewerAccess = await db
      .select()
      .from(userSystems)
      .where(
        and(
          eq(userSystems.clerkUserId, ctx.userId),
          eq(userSystems.systemId, systemId),
        ),
      )
      .limit(1);
    isViewer = viewerAccess.length > 0;
  }

  const canRead = ctx.isAdmin || ctx.isClaudeDev || isOwner || isViewer;
  const canWrite = ctx.isAdmin || isOwner;

  if (!canRead && !ctx.userId) {
    return unauthorized();
  }
  if (!canRead) {
    return forbidden("No access to this system");
  }
  if (options.requireWrite && !canWrite) {
    return forbidden("Write access required");
  }

  return {
    ...ctx,
    userId: ctx.userId!,
    system,
    isOwner,
    isViewer,
    canRead,
    canWrite,
  };
}
