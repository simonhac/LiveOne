import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "./auth-utils";
import { cliBearerToken } from "./cli-auth/bearer";
import { verifyCliToken } from "./cli-auth/verify";
import {
  DeviceConfigRegistry,
  type DeviceConfigView,
} from "@/lib/registry/device-config";
import { ownsSubject } from "@/lib/control/ownership";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboard } from "@/lib/dashboard/dashboards";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { grantedDeviceScopeForUser } from "@/lib/dashboard/grants";
import type { ServerTimer } from "@/lib/server-timing";
import {
  subjectForHandle,
  type ServingSubject,
  type SubjectPreference,
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

// Device access result
export interface DeviceAuthContext extends AuthenticatedContext {
  device: DeviceConfigView;
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

  // An operator CLI token (`Authorization: Bearer lo_cli_…`). The middleware has already let this
  // request past the edge WITHOUT authorizing it (see isCliTokenRoute in lib/route-matchers.ts), so
  // this branch is the single enforcement point for that path.
  //
  // 🛑 It RETURNS on every outcome and never falls through to `auth()`. Falling through on an
  // invalid token would let a request that presents a garbage CLI credential still succeed on a
  // browser session cookie — a confusing, and eventually exploitable, overlap. An invalid token
  // yields `userId: null`, which `requireAuth` turns into a clean 401; the verifier's own reasons
  // (unknown secret / expired / revoked) stay server-side, so the response never tells a caller
  // which half of a guess was right.
  const cliToken = cliBearerToken(request);
  if (cliToken) {
    const verified = timer
      ? await timer.time("clerk", () => verifyCliToken(cliToken))
      : await verifyCliToken(cliToken);
    if (!verified)
      return {
        userId: null,
        isAdmin: false,
        isCron: false,
        isClaudeDev: false,
      };
    return {
      userId: verified.userId,
      isAdmin: verified.isAdmin,
      isCron: false,
      isClaudeDev: false,
    };
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

/**
 * Require device access (owner, viewer, or admin).
 *
 * `options.requireWrite` is the CONFIG write gate: owner **or** admin. Admins administer other
 * people's devices — settings, credentials, metadata — and that is unchanged.
 *
 * 🛑 `options.requireOwner` is the CONTROL gate and is strictly narrower: the caller must BE the
 * device's owner. An admin who does not own the device is refused, and an ownerless device is
 * commandable by nobody. See `lib/control/ownership.ts` for why (commands run on the owner's
 * vendor credentials). Every route that actuates hardware must set it; nothing else should.
 */
export async function requireDeviceAccess(
  request: NextRequest,
  systemId: number,
  options: { requireWrite?: boolean; requireOwner?: boolean } = {},
  timer?: ServerTimer,
): Promise<DeviceAuthContext | NextResponse> {
  const ctx = await getAuthContext(request, timer);

  // Get the device's config. Strictly real devices — the area-view path is requireDashboardAccess's.
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  if (!device) {
    return NextResponse.json({ error: "System not found" }, { status: 404 });
  }

  // Check access levels
  const isOwner = ctx.userId === device.ownerClerkUserId;
  // Ownerless devices are PUBLIC: readable by everyone (but writable only by admins).
  const isPublic = device.ownerClerkUserId == null;

  // There used to be a fourth read term here — a `user_systems` probe for a per-device viewer grant.
  // That table was dropped in migration 0045 (slice F); it held 0 rows on prod and never conveyed
  // write access, so `canWrite` is unchanged and `canRead` only narrowed. A dashboard grantee still
  // gets in via requireDashboardAccess's grantedDeviceScopeForUser fallback below.
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
  // 🛑 The control gate. Strictly narrower than `canWrite`: `ownsSubject` refuses a non-owner
  // admin AND refuses the `null === null` match an anonymous caller would otherwise get on an
  // ownerless device.
  if (
    options.requireOwner &&
    !ownsSubject(ctx.userId, device.ownerClerkUserId)
  ) {
    return forbidden("Only the device owner can control this device");
  }

  return {
    ...ctx,
    userId: ctx.userId!,
    device,
    isOwner,
    canRead,
    canWrite,
  };
}

// Dashboard access context — like a read-only DeviceAuthContext but userId may be null when access
// is granted via a public per-dashboard share token.
export interface DashboardAuthContext {
  /**
   * What the request is about, area-natively (config-v4 Phase 13 PR 1). The serving path reads THIS.
   */
  subject: ServingSubject;
  userId: string | null;
  canRead: boolean;
  canWrite: boolean;
  /**
   * Does this viewer OWN the subject? Strictly `ownsSubject` — an admin who does not own it is
   * false, and two nulls (anonymous caller, ownerless subject) are false. This is the field the
   * control gate is expressed against, on both sides of the wire; `canWrite` (owner OR admin)
   * remains the config-write field and is untouched.
   */
  isOwner: boolean;
  viaShareToken: boolean;
}

/**
 * The `ServingSubject` for a handle that has already been AUTHORIZED under the same `prefer`.
 *
 * 🛑 `prefer` must be the SAME preference the authorization decision above was made under. Resolving a
 * subject under one preference after authorizing under the other is exactly trap D-l: it would return an
 * entity that was never checked. Callers therefore pass the `prefer` they were called with, never a
 * literal. Both legs are per-request memoized, so this costs no extra round trip.
 */
async function subjectFor(
  handle: number,
  prefer: SubjectPreference,
): Promise<ServingSubject> {
  const subject = await subjectForHandle(handle, prefer);
  if (!subject) {
    // Unreachable: authorization above already resolved this handle through the same two readers.
    throw new Error(`handle ${handle} authorized but no serving subject`);
  }
  return subject;
}

/**
 * Access to a dashboard's data routes (P4). Grants READ via a valid per-dashboard share token
 * (`?access=`) whose dashboard targets this exact `systemId` — a public, read-only, single-device
 * grant that mirrors the existing ownerless-device public path. Otherwise falls through to
 * `requireDeviceAccess` (owner/admin/viewer/public). A bad or mismatched token never blocks normal
 * auth (the caller may also be logged in).
 *
 * 🛑 **`prefer` selects WHICH ENTITY is authorized, not merely which one is returned.** A handle can name
 * both a device and an area (handle 13 is a real Sigenergy device AND a 3-member Area), and the area is
 * the WIDER scope — its bindings/union contain the device sharing its handle. Before Phase 13 PR 2,
 * `/api/data` authorized such a handle device-first and then re-took the area leg for an explicit
 * `?areaId=` WITHOUT re-authorizing, which was safe only because the point interior also dispatched
 * device-first; PR 2 made that interior lock explicit rather than incidental, and closed this by making
 * `prefer: "area"` authorize against the AREA's own owner/grant scope here. So an `?areaId=` caller that
 * holds only the device's grant is now refused instead of inheriting it. Trap D-l.
 */
export async function requireDashboardAccess(
  request: NextRequest,
  systemId: number,
  timer?: ServerTimer,
  prefer: SubjectPreference = "device",
): Promise<DashboardAuthContext | NextResponse> {
  const token = new URL(request.url).searchParams.get("access");
  if (token) {
    const valid = await validateDashboardShareToken(token);
    if (valid) {
      const dash = await getDashboard(valid.dashboardId);
      // Authorize when `systemId` is within the dashboard's read scope — the UNION of the Areas its
      // v4 document references (areas-and-dashboards.md §2). An escalation attempt
      // (?systemId=<other>&access=<token>) is excluded and falls through to normal auth.
      if (dash) {
        const allowed = await allowedSystemIds({ doc: dash.doc });
        if (allowed.includes(systemId)) {
          // The handle must still name something under the requested preference. `allowedSystemIds` is
          // deliberately leg-agnostic: its scope is computed through
          // `PointManager.getActivePointsForDevice`, which is device-first-ALWAYS at the interior, so a
          // token whose dashboard names an Area can only ever have been credited with the device's own
          // points — `allowed.includes(13)` never certifies more than "this dashboard shows handle 13".
          // Both legs resolve to that same interior-locked point set, so either is safe to grant.
          const subject = await subjectForHandle(systemId, prefer);
          if (subject) {
            return {
              subject,
              userId: null,
              canRead: true,
              canWrite: false,
              // A share token is a read grant to an anonymous viewer. It owns nothing.
              isOwner: false,
              viaShareToken: true,
            };
          }
        }
      }
    }
  }

  // The AREA leg. Taken when this handle names an area AND either the caller asked for the area
  // explicitly (`?areaId=`) or the handle names no device at all.
  //
  // 🛑 The `prefer === "area"` disjunct IS the Phase 13 PR 2 authorization fix. Previously this branch
  // was gated on `isAreaHandle` — i.e. `!device && area` — so a COLLIDING handle (13) never reached it
  // and `/api/data`'s `?areaId=` re-take inherited the device-first grant for the wider entity. Now the
  // area is authorized against ITS OWN owner/admin/public/grant scope before it can be served. The
  // pure-area handles (7, 8, 1000001, 1000002) have no device, so they take this branch under either
  // preference exactly as before — the union path for genuinely multi-device areas is untouched.
  const area = await DeviceConfigRegistry.areaByHandle(systemId);
  const device = await DeviceConfigRegistry.deviceByHandle(systemId);
  if (area && (prefer === "area" || !device)) {
    const ctx = await getAuthContext(request, timer);
    const isOwner = ctx.userId === area.ownerUserId;
    const isPublic = area.ownerUserId == null;
    // A grantee of a dashboard whose scope includes this area handle gets read-only access.
    const grantReadOk =
      ctx.userId != null &&
      (await grantedDeviceScopeForUser(ctx.userId)).has(systemId);
    const canRead =
      ctx.isAdmin || ctx.isClaudeDev || isOwner || isPublic || grantReadOk;
    if (!canRead && !ctx.userId) return unauthorized();
    if (!canRead) return forbidden("No access to this area");
    return {
      subject: await subjectFor(systemId, "area"),
      userId: ctx.userId ?? null,
      canRead: true,
      canWrite: ctx.isAdmin || isOwner,
      // Not `isOwner` above: that one is the loose `userId === ownerUserId`, which is `true` for an
      // anonymous caller on an ownerless area. Ownership must be strict.
      isOwner: ownsSubject(ctx.userId, area.ownerUserId),
      viaShareToken: false,
    };
  }

  const result = await requireDeviceAccess(request, systemId, {}, timer);
  if (result instanceof NextResponse) {
    // Grant fallback: an authed grantee gets read-only access to devices within the scope of any
    // dashboard shared with them (the same scope a share token would grant), without needing device
    // ownership/viewer access. Only consulted once normal device auth has denied.
    const ctx = await getAuthContext(request, timer);
    if (
      ctx.userId != null &&
      (await grantedDeviceScopeForUser(ctx.userId)).has(systemId)
    ) {
      const subject = await subjectForHandle(systemId, prefer);
      if (subject) {
        return {
          subject,
          userId: ctx.userId,
          canRead: true,
          canWrite: false,
          // A dashboard grantee is a read-only guest, never the owner.
          isOwner: false,
          viaShareToken: false,
        };
      }
    }
    return result;
  }
  return {
    // `requireDeviceAccess` authorized the DEVICE, so the subject is the device — regardless of
    // `prefer`. An `?areaId=` request only reaches here when the handle names no area, in which case
    // there is no area leg to prefer.
    subject: await subjectFor(systemId, "device"),
    userId: result.userId,
    canRead: result.canRead,
    canWrite: result.canWrite,
    isOwner: ownsSubject(result.userId, result.device.ownerClerkUserId),
    viaShareToken: false,
  };
}
