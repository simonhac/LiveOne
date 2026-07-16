import { cache } from "react";
import { eq, max, isNotNull, isNull, and, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { isProduction } from "@/lib/env";
import { getUserIdByUsername } from "@/lib/user-cache";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { ensureAreaOfOne } from "@/lib/areas/sync";
import {
  systems as pgSystems,
  pollingStatus as pgPollingStatus,
  userSystems as pgUserSystems,
  areas as pgAreas,
} from "@/lib/db/planetscale/schema";

// Export the type for a system from the database
export type System = InferSelectModel<typeof pgSystems>;
export type PollingStatus = InferSelectModel<typeof pgPollingStatus>;

export type Area = InferSelectModel<typeof pgAreas>;

// Combined system with polling status
export type SystemWithPolling = System & {
  pollingStatus?: PollingStatus | null;
};

/**
 * An "area view" — a SystemWithPolling shape synthesized from a multi-device Area whose integer
 * addressing handle (`legacy_system_id`) has NO real `systems` row. It is the SERVER-ONLY resolution
 * of that handle for the dashboard data path (points/flow/auth resolve via `area_bindings` + members);
 * it is deliberately kept OUT of the systems/devices/admin lists. Owns no points and never polls, so
 * device/polling fields are null.
 */
function synthesizeAreaView(area: Area): SystemWithPolling | null {
  if (area.legacySystemId == null) return null;
  return {
    id: area.legacySystemId,
    ownerClerkUserId: area.ownerClerkUserId,
    vendorType: "area",
    vendorSiteId: `area:${area.legacySystemId}`,
    status: area.status,
    displayName: area.displayName,
    alias: area.alias,
    model: null,
    serial: null,
    ratings: null,
    solarSize: null,
    batterySize: null,
    location: area.location,
    metadata: null,
    config: null,
    timezoneOffsetMin: area.timezoneOffsetMin,
    displayTimezone: area.displayTimezone,
    createdAt: area.createdAt,
    updatedAt: area.updatedAt,
    commissionedOn: null, // area views own no points and never poll — no vendor commission date
    pollingStatus: null,
  };
}

// Input shape for creating a system (shared by createSystem and its routed inserts).
type CreateSystemData = {
  ownerClerkUserId: string;
  vendorType: string;
  vendorSiteId: string;
  status?: string;
  displayName: string;
  alias?: string | null;
  model?: string | null;
  serial?: string | null;
  ratings?: string | null;
  solarSize?: string | null;
  batterySize?: string | null;
  location?: any;
  metadata?: any;
  timezoneOffsetMin?: number;
  displayTimezone?: string;
};

/**
 * Detect a Postgres unique_violation (SQLSTATE '23505'), e.g. the alias-unique collision.
 * `pg` puts the SQLSTATE on the error's `code` field.
 */
function isPgUniqueViolation(e: unknown): boolean {
  return (
    !!e && typeof e === "object" && (e as { code?: unknown }).code === "23505"
  );
}

/** Flatten a systems⋈polling_status join row (any extra joined tables are ignored). */
function toSystemWithPolling(row: {
  systems: System;
  polling_status: PollingStatus | null;
}): SystemWithPolling {
  return { ...row.systems, pollingStatus: row.polling_status };
}

/**
 * Per-request memoized point lookup of a real system by id (with polling status). React's `cache()`
 * dedupes repeated lookups of the same id within a single request; nothing is shared across requests,
 * so config is always fresh. Outside a request (Jest/scripts) it just runs unmemoized.
 */
const fetchSystemById = cache(
  async (id: number): Promise<SystemWithPolling | null> => {
    const [row] = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .where(eq(pgSystems.id, id))
      .limit(1);
    return row ? toSystemWithPolling(row) : null;
  },
);

/** Per-request memoized lookup of the Area whose addressing handle is `id` → synthesized area view. */
const fetchAreaByHandle = cache(async (id: number): Promise<Area | null> => {
  const [area] = await requirePlanetscaleDb()
    .select()
    .from(pgAreas)
    .where(eq(pgAreas.legacySystemId, id))
    .limit(1);
  return area ?? null;
});

/** Per-request memoized lookup of a real system by vendor site id (OAuth/webhook dedup). */
const fetchSystemByVendorSiteId = cache(
  async (vendorSiteId: string): Promise<SystemWithPolling | null> => {
    const [row] = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .where(eq(pgSystems.vendorSiteId, vendorSiteId))
      .limit(1);
    return row ? toSystemWithPolling(row) : null;
  },
);

/**
 * Reads system config via targeted, indexed queries — no fleet-wide load. Each access is either an
 * O(1) point lookup (by id / vendor site id) or a query bounded by what one user can see; all are
 * memoized per-request by React's `cache()`. `getInstance()` is a stateless facade (no DB work, no
 * cross-request cache); mutations write straight through and the next request reads them.
 *
 * Scales to large fleets because nothing materializes all systems. Two callers remain inherently
 * "all" — `getAllSystems` (admin table; paginated in a later phase) and `getActiveSystems` (the
 * poll-all cron; a collection-sharding concern, not a query-shape one).
 */
export class SystemsManager {
  private static instance: SystemsManager | null = null;

  private constructor() {}

  /** Get the (stateless) SystemsManager facade. Cheap: no DB work, no cross-request cache. */
  static getInstance(): SystemsManager {
    return (SystemsManager.instance ??= new SystemsManager());
  }

  /** Get a real system by id (with polling status). */
  async getSystem(systemId: number): Promise<SystemWithPolling | null> {
    return fetchSystemById(systemId);
  }

  /**
   * Resolve a handle for the DASHBOARD DATA PATH: a real system, OR an area view (a multi-device Area
   * with no `systems` row). Use this — not getSystem — wherever an Area's whole-area data/auth/flow is
   * served. getSystem stays real-only (devices/admin/polling).
   */
  async getViewableSystem(systemId: number): Promise<SystemWithPolling | null> {
    const real = await fetchSystemById(systemId);
    if (real) return real; // real row wins (an area-of-one)
    const area = await fetchAreaByHandle(systemId);
    return area ? synthesizeAreaView(area) : null;
  }

  /** Whether `systemId` is an area view (a multi-device Area handle with no real `systems` row). */
  async isAreaHandle(systemId: number): Promise<boolean> {
    if (await fetchSystemById(systemId)) return false; // real row wins
    return (await fetchAreaByHandle(systemId)) != null;
  }

  /** Get a real system by vendor site id (first match; vendor site ids are not unique). */
  async getSystemByVendorSiteId(
    vendorSiteId: string,
  ): Promise<SystemWithPolling | null> {
    return fetchSystemByVendorSiteId(vendorSiteId);
  }

  /**
   * Resolve a system from a pretty `/device/{username}/{alias}` URL. Resolves the username to a Clerk
   * id first (cached), then a single indexed lookup on the unique (owner, alias) pair.
   */
  async getSystemByUsernameAndAlias(
    username: string,
    alias: string,
  ): Promise<SystemWithPolling | null> {
    const ownerClerkUserId = await getUserIdByUsername(username);
    if (!ownerClerkUserId) return null;

    const [row] = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .where(
        and(
          eq(pgSystems.ownerClerkUserId, ownerClerkUserId),
          eq(pgSystems.alias, alias),
        ),
      )
      .limit(1);
    return row ? toSystemWithPolling(row) : null;
  }

  /** All active real systems. Inherently fleet-wide (poll-all cron / flow recompute). */
  async getActiveSystems(): Promise<SystemWithPolling[]> {
    const rows = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .where(eq(pgSystems.status, "active"));
    return rows.map(toSystemWithPolling);
  }

  /**
   * All real systems (any status). Inherently fleet-wide — used by the admin systems table, which a
   * later phase will paginate/search. Avoid in request-hot paths.
   */
  async getAllSystems(): Promise<SystemWithPolling[]> {
    const rows = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId));
    return rows.map(toSystemWithPolling);
  }

  /** Real systems owned by a user (any status). Indexed on owner_clerk_user_id. */
  async getSystemsByOwner(userId: string): Promise<SystemWithPolling[]> {
    const rows = await requirePlanetscaleDb()
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .where(eq(pgSystems.ownerClerkUserId, userId));
    return rows.map(toSystemWithPolling);
  }

  /** Active area-view handles (multi-device Area handles, no real row) — for the daily flow recompute. */
  async getActiveAreaHandles(): Promise<number[]> {
    const rows = await requirePlanetscaleDb()
      .select({ id: pgAreas.legacySystemId })
      .from(pgAreas)
      .leftJoin(pgSystems, eq(pgSystems.id, pgAreas.legacySystemId))
      .where(
        and(
          isNotNull(pgAreas.legacySystemId),
          isNull(pgSystems.id), // no real row ⇒ it's an area view
          eq(pgAreas.status, "active"),
        ),
      );
    return rows.map((r) => r.id).filter((id): id is number => id != null);
  }

  /**
   * Systems visible to a user for the switcher: the ones they OWN, are GRANTED (via user_systems), or
   * that are PUBLIC (ownerless, readable by everyone). Bounded indexed queries — no fleet load and no
   * admin-sees-all branch: an admin's cross-system reach is the admin systems table, not this list.
   * Area views are intentionally excluded (the switcher lists real devices only).
   */
  async getSystemsVisibleByUser(userId: string, activeOnly: boolean = true) {
    const db = requirePlanetscaleDb();

    // Owned + public in one indexed pass; granted via the user_systems join.
    const ownedOrPublic = await db
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .where(
        or(
          eq(pgSystems.ownerClerkUserId, userId),
          isNull(pgSystems.ownerClerkUserId),
        ),
      );
    const granted = await db
      .select()
      .from(pgSystems)
      .leftJoin(pgPollingStatus, eq(pgSystems.id, pgPollingStatus.systemId))
      .innerJoin(
        pgUserSystems,
        and(
          eq(pgUserSystems.systemId, pgSystems.id),
          eq(pgUserSystems.clerkUserId, userId),
        ),
      );

    const byId = new Map<number, SystemWithPolling>();
    for (const r of ownedOrPublic)
      byId.set(r.systems.id, toSystemWithPolling(r));
    for (const r of granted) byId.set(r.systems.id, toSystemWithPolling(r));

    return Array.from(byId.values())
      .filter((s) => !activeOnly || s.status === "active")
      .filter((s) => s.displayName && s.vendorSiteId) // must have display name + vendor site id
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((s) => ({
        id: s.id,
        displayName: s.displayName,
        vendorSiteId: s.vendorSiteId,
        vendorType: s.vendorType,
        status: s.status,
        ownerClerkUserId: s.ownerClerkUserId,
        alias: s.alias,
      }));
  }

  /**
   * The user's "primary" visible system — owned-first, else the first visible (by display name), or
   * null if they can see none. Single source of truth for the `/dashboard` landing redirect and the
   * "Go to Systems" (`/device`) redirect, which previously each copy-pasted this owned-first logic.
   */
  async getPrimaryVisibleSystem(userId: string) {
    const visible = await this.getSystemsVisibleByUser(userId, true);
    if (visible.length === 0) return null;
    const owned = visible.filter((s) => s.ownerClerkUserId === userId);
    return owned.length > 0 ? owned[0] : visible[0];
  }

  /**
   * Create a new system in the database.
   * @param systemData - The system data to insert
   * @returns The created system
   */
  async createSystem(systemData: CreateSystemData): Promise<System> {
    const newSystem = await this.insertSystemToPg(systemData);

    console.log(
      `[SystemsManager] Created system ${newSystem.id} (${systemData.vendorType}) for user ${systemData.ownerClerkUserId}`,
    );

    // Every device gets a first-class area-of-one EAGERLY at create-time, so the device view, the
    // membership (`area_devices`), and flow keying resolve against a real Area — no synthesized shim.
    // Best-effort: an area-mint failure must NEVER orphan the freshly-created system row, so we
    // log-and-continue; the daily `resolveLogicalSystem` heal and the location route remain backstops.
    // `ensureAreaOfOne` is idempotent + race-safe on `areas_legacy_system_unique`.
    try {
      await ensureAreaOfOne(newSystem);
    } catch (e) {
      console.warn(
        `[SystemsManager] area-of-one mint deferred for system ${newSystem.id}:`,
        e,
      );
    }

    // No cache to invalidate: config is read per-request, so the next request sees the new system.
    return newSystem;
  }

  /**
   * Create a HELPER device — a derived, non-physical, never-polled `systems` row (vendor_type='helper')
   * that lives in an Area and owns the Area's COMPUTED points (battery-provenance blend, …). Unlike
   * {@link createSystem} it does NOT mint an area-of-one: a helper is a MEMBER of an existing Area
   * (wired by `lib/areas/helper.ts::ensureHelperDevice`), never its own area. Owned by the Area's owner
   * for access control (NOT ownerless — the blend is private household-derived data).
   */
  async createHelperDevice(params: {
    ownerClerkUserId: string | null;
    vendorSiteId: string;
    displayName: string;
    timezoneOffsetMin: number;
    displayTimezone: string;
  }): Promise<System> {
    const sys = await this.insertSystemToPg({
      ownerClerkUserId: params.ownerClerkUserId,
      vendorType: "helper",
      vendorSiteId: params.vendorSiteId,
      status: "active",
      displayName: params.displayName,
      alias: null,
      timezoneOffsetMin: params.timezoneOffsetMin,
      displayTimezone: params.displayTimezone,
    } as CreateSystemData);
    console.log(
      `[SystemsManager] Created helper device ${sys.id} (${params.vendorSiteId})`,
    );
    return sys;
  }

  /**
   * Update an existing system.
   *
   * Updates Postgres only (config writes are Postgres-only). The patch maps 1:1 —
   * PG jsonb/timestamp columns accept plain objects/Dates directly, so no per-field
   * mapping is needed. `updatedAt` is always stamped to now regardless of the patch.
   */
  async updateSystem(systemId: number, patch: Partial<System>): Promise<void> {
    // Never let the caller override the id or the freshly-stamped updatedAt.
    const { id: _ignoredId, updatedAt: _ignoredUpdatedAt, ...rest } = patch;
    const values = { ...rest, updatedAt: new Date() };

    await requirePlanetscaleDb()
      .update(pgSystems)
      .set(values as Partial<InferSelectModel<typeof pgSystems>>)
      .where(eq(pgSystems.id, systemId));
  }

  /**
   * Delete a system.
   *
   * Deletes from Postgres only.
   */
  async deleteSystem(systemId: number): Promise<void> {
    await requirePlanetscaleDb()
      .delete(pgSystems)
      .where(eq(pgSystems.id, systemId));
  }

  /**
   * Insert the system into Postgres. The alias-unique collision is a unique_violation,
   * surfaced with SQLSTATE '23505'; rethrown unchanged so callers keep their handling.
   */
  private async insertSystemToPg(
    systemData: CreateSystemData,
  ): Promise<System> {
    const pg = requirePlanetscaleDb();

    // Dev-id policy: explicit ids from 10000 in dev, serial in prod.
    let systemId: number | undefined = undefined;
    if (!isProduction()) {
      const DEV_SYSTEM_ID_START = 10000;
      const [{ maxId }] = await pg
        .select({ maxId: max(pgSystems.id) })
        .from(pgSystems);
      systemId =
        maxId && maxId >= DEV_SYSTEM_ID_START ? maxId + 1 : DEV_SYSTEM_ID_START;
    }

    try {
      const [newSystem] = await pg
        .insert(pgSystems)
        .values({
          ...(systemId !== undefined ? { id: systemId } : {}),
          ownerClerkUserId: systemData.ownerClerkUserId,
          vendorType: systemData.vendorType,
          vendorSiteId: systemData.vendorSiteId,
          status: systemData.status || "active",
          displayName: systemData.displayName,
          alias: systemData.alias,
          model: systemData.model,
          serial: systemData.serial,
          ratings: systemData.ratings,
          solarSize: systemData.solarSize,
          batterySize: systemData.batterySize,
          location: systemData.location,
          metadata: systemData.metadata,
          timezoneOffsetMin: systemData.timezoneOffsetMin ?? 600, // Default to AEST
          displayTimezone: systemData.displayTimezone ?? "Australia/Melbourne", // Default timezone
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      // PG createdAt/updatedAt are Date-typed; the row is structurally the System
      // shape the caller expects.
      return newSystem as unknown as System;
    } catch (e) {
      if (isPgUniqueViolation(e)) {
        console.warn(
          `[SystemsManager] Postgres alias-unique collision (23505) creating system for user ${systemData.ownerClerkUserId}`,
        );
      }
      throw e;
    }
  }
}
