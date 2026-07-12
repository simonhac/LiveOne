import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "./auth-utils";
import { SystemsManager, SystemWithPolling } from "./systems-manager";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { userSystems } from "@/lib/db/planetscale/schema";
import { eq, and } from "drizzle-orm";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { grantedSystemScopeForUser } from "@/lib/dashboard/grants";

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
  // Ownerless systems are PUBLIC: readable by everyone (but writable only by admins).
  const isPublic = system.ownerClerkUserId == null;
  let isViewer = false;

  if (ctx.userId && !isOwner && !ctx.isAdmin) {
    // Check userSystems table for viewer access
    const viewerAccess = await requirePlanetscaleDb()
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

  const canRead =
    ctx.isAdmin || ctx.isClaudeDev || isOwner || isViewer || isPublic;
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

// Dashboard access context — like a read-only SystemAuthContext but userId may be null when access
// is granted via a public per-dashboard share token.
export interface DashboardAuthContext {
  system: SystemWithPolling;
  userId: string | null;
  canRead: boolean;
  canWrite: boolean;
  viaShareToken: boolean;
}

/**
 * Access to a dashboard's data routes (P4). Grants READ via a valid per-dashboard share token
 * (`?access=`) whose dashboard targets this exact `systemId` — a public, read-only, single-system
 * grant that mirrors the existing ownerless-system public path. Otherwise falls through to
 * `requireSystemAccess` (owner/admin/viewer/public). A bad or mismatched token never blocks normal
 * auth (the caller may also be logged in).
 */
export async function requireDashboardAccess(
  request: NextRequest,
  systemId: number,
): Promise<DashboardAuthContext | NextResponse> {
  const token = new URL(request.url).searchParams.get("access");
  if (token) {
    const valid = await validateDashboardShareToken(token);
    if (valid) {
      const dash = await getDashboard(valid.dashboardId);
      // Authorize when `systemId` is within the dashboard's read scope — the UNION of its section
      // Areas (areas-and-dashboards.md §2), derived purely from the descriptor. An escalation attempt
      // (?systemId=<other>&access=<token>) is excluded and falls through to normal auth.
      if (dash) {
        const allowed = await allowedSystemIds({
          descriptor: dash.descriptor,
        });
        if (allowed.includes(systemId)) {
          const system =
            await SystemsManager.getInstance().getViewableSystem(systemId);
          if (system) {
            return {
              system,
              userId: null,
              canRead: true,
              canWrite: false,
              viaShareToken: true,
            };
          }
        }
      }
    }
  }

  // Area-view handle (a multi-device Area with no real `systems` row): resolve access area-natively
  // (owner / admin / public). requireSystemAccess stays strict (real systems + /device routes).
  const sm = SystemsManager.getInstance();
  if (await sm.isAreaHandle(systemId)) {
    const ctx = await getAuthContext(request);
    const view = await sm.getViewableSystem(systemId);
    if (!view) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }
    const isOwner = ctx.userId === view.ownerClerkUserId;
    const isPublic = view.ownerClerkUserId == null;
    // A grantee of a dashboard whose scope includes this area handle gets read-only access.
    const grantReadOk =
      ctx.userId != null &&
      (await grantedSystemScopeForUser(ctx.userId)).has(systemId);
    const canRead =
      ctx.isAdmin || ctx.isClaudeDev || isOwner || isPublic || grantReadOk;
    if (!canRead && !ctx.userId) return unauthorized();
    if (!canRead) return forbidden("No access to this area");
    return {
      system: view,
      userId: ctx.userId ?? null,
      canRead: true,
      canWrite: ctx.isAdmin || isOwner,
      viaShareToken: false,
    };
  }

  const result = await requireSystemAccess(request, systemId);
  if (result instanceof NextResponse) {
    // Grant fallback: an authed grantee gets read-only access to systems within the scope of any
    // dashboard shared with them (the same scope a share token would grant), without needing system
    // ownership/viewer access. Only consulted once normal system auth has denied.
    const ctx = await getAuthContext(request);
    if (
      ctx.userId != null &&
      (await grantedSystemScopeForUser(ctx.userId)).has(systemId)
    ) {
      const system =
        await SystemsManager.getInstance().getViewableSystem(systemId);
      if (system) {
        return {
          system,
          userId: ctx.userId,
          canRead: true,
          canWrite: false,
          viaShareToken: false,
        };
      }
    }
    return result;
  }
  return {
    system: result.system,
    userId: result.userId,
    canRead: result.canRead,
    canWrite: result.canWrite,
    viaShareToken: false,
  };
}
