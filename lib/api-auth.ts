import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "./auth-utils";
import {
  DeviceConfigRegistry,
  type DeviceConfigView,
} from "@/lib/registry/device-config";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { grantedSystemScopeForUser } from "@/lib/dashboard/grants";
import type { ServerTimer } from "@/lib/server-timing";
import {
  subjectForHandle,
  type ServingSubject,
} from "@/lib/dashboard/subject";

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
  system: DeviceConfigView;
  isOwner: boolean;
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

// Base auth check - returns context. The optional `timer` (Server-Timing instrumentation — see
// lib/server-timing.ts) splits the two Clerk-side costs: `clerk` = session/JWT resolution,
// `admin` = the isUserAdmin check (which falls back to a Clerk API network call when the
// isPlatformAdmin session claim isn't configured). Duplicate spans in one response mean this ran
// more than once (e.g. a requireDashboardAccess fallback branch) — that repetition is itself signal.
export async function getAuthContext(
  request: NextRequest,
  timer?: ServerTimer,
): Promise<AuthContext> {
  const isClaudeDev = isClaudeDevRequest(request);
  const isCron = isCronRequest(request);

  // Claude-dev bypasses normal auth
  if (isClaudeDev) {
    return { userId: "claude-dev", isAdmin: true, isCron, isClaudeDev };
  }

  const { userId } = timer
    ? await timer.time("clerk", () => auth())
    : await auth();
  const isAdmin = userId
    ? timer
      ? await timer.time("admin", () => isUserAdmin(userId))
      : await isUserAdmin(userId)
    : false;

  return { userId, isAdmin, isCron, isClaudeDev };
}

// ===== Authorization Functions =====

// Require authentication only
export async function requireAuth(
  request: NextRequest,
  timer?: ServerTimer,
): Promise<AuthenticatedContext | NextResponse> {
  const ctx = await getAuthContext(request, timer);
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
  timer?: ServerTimer,
): Promise<SystemAuthContext | NextResponse> {
  const ctx = await getAuthContext(request, timer);

  // Get the device's config. Strictly real devices — the area-view path is requireDashboardAccess's.
  const system = await DeviceConfigRegistry.deviceByHandle(systemId);
  if (!system) {
    return NextResponse.json({ error: "System not found" }, { status: 404 });
  }

  // Check access levels
  const isOwner = ctx.userId === system.ownerClerkUserId;
  // Ownerless systems are PUBLIC: readable by everyone (but writable only by admins).
  const isPublic = system.ownerClerkUserId == null;

  // There used to be a fourth read term here — a `user_systems` probe for a per-system viewer grant.
  // That table was dropped in migration 0045 (slice F); it held 0 rows on prod and never conveyed
  // write access, so `canWrite` is unchanged and `canRead` only narrowed. A dashboard grantee still
  // gets in via requireDashboardAccess's grantedSystemScopeForUser fallback below.
  const canRead = ctx.isAdmin || ctx.isClaudeDev || isOwner || isPublic;
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
    canRead,
    canWrite,
  };
}

// Dashboard access context — like a read-only SystemAuthContext but userId may be null when access
// is granted via a public per-dashboard share token.
export interface DashboardAuthContext {
  /**
   * What the request is about, area-natively (config-v4 Phase 13 PR 1). The serving path reads THIS.
   */
  subject: ServingSubject;
  /**
   * The legacy device-shaped view — an Area still arrives here as `synthesizeAreaView`'s fabrication.
   * Retained only for the readers PR 2 repoints (`/api/history`'s series layer, run-periods); it is
   * always the DEVICE-FIRST resolution of the same handle, so it can never disagree with `subject`.
   */
  system: DeviceConfigView;
  userId: string | null;
  canRead: boolean;
  canWrite: boolean;
  viaShareToken: boolean;
}

/**
 * The `ServingSubject` for a handle whose device-shaped view has already resolved.
 *
 * Device-first, deliberately: `viewableByHandle` (device-first, LOCKED) is what produced `view`, so any
 * other precedence here would describe a different entity than the one just authorized. Both legs go
 * through the same per-request-memoized readers, so this costs no extra round trip. Trap D-l.
 */
async function subjectFor(handle: number): Promise<ServingSubject> {
  const subject = await subjectForHandle(handle, "device");
  if (!subject) {
    // Unreachable: `viewableByHandle` already resolved this handle through the same two readers.
    throw new Error(`handle ${handle} resolved a view but no serving subject`);
  }
  return subject;
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
  timer?: ServerTimer,
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
          doc: dash.doc,
        });
        if (allowed.includes(systemId)) {
          const system = await DeviceConfigRegistry.viewableByHandle(systemId);
          if (system) {
            return {
              subject: await subjectFor(systemId),
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
  if (await DeviceConfigRegistry.isAreaHandle(systemId)) {
    const ctx = await getAuthContext(request, timer);
    const view = await DeviceConfigRegistry.viewableByHandle(systemId);
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
      subject: await subjectFor(systemId),
      system: view,
      userId: ctx.userId ?? null,
      canRead: true,
      canWrite: ctx.isAdmin || isOwner,
      viaShareToken: false,
    };
  }

  const result = await requireSystemAccess(request, systemId, {}, timer);
  if (result instanceof NextResponse) {
    // Grant fallback: an authed grantee gets read-only access to systems within the scope of any
    // dashboard shared with them (the same scope a share token would grant), without needing system
    // ownership/viewer access. Only consulted once normal system auth has denied.
    const ctx = await getAuthContext(request, timer);
    if (
      ctx.userId != null &&
      (await grantedSystemScopeForUser(ctx.userId)).has(systemId)
    ) {
      const system = await DeviceConfigRegistry.viewableByHandle(systemId);
      if (system) {
        return {
          subject: await subjectFor(systemId),
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
    subject: await subjectFor(systemId),
    system: result.system,
    userId: result.userId,
    canRead: result.canRead,
    canWrite: result.canWrite,
    viaShareToken: false,
  };
}
