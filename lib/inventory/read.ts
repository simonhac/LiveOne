import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  areas,
  devices,
  points,
  areaBindings,
  automations,
  dashboards,
  dashboardGrants,
  shareTokens,
  areaCalendarTokens,
  batteryProvenanceDaily,
  pointReadingsFlowAttr1d,
  deviceState,
  derivedIntervals,
  derivedIntervalProvenance,
} from "@/lib/db/planetscale/schema";
import {
  Area,
  Device,
  Point,
  Binding,
  Derivation,
  Automation,
  Dashboard,
} from "@/lib/ids";
import { listReadableDerivations } from "@/lib/derivations/scope";
import { dashboardAreaUuids } from "@/lib/dashboard/composition";
import { allowedSystemIds } from "@/lib/dashboard/access";
import { collectRefs } from "@/lib/dashboard/v4-validate";
import { isDashboardV4 } from "@/lib/dashboard/v4";
import { ReadingsDao } from "@/lib/readings/dao";
import {
  parseAutomationAction,
  parseAutomationTrigger,
} from "@/lib/automations/types";
import type { TreeInventory } from "./types";

/** Metadata-only inventory. No queries against raw readings, sessions or commands.
 * The normal scope is OWNED objects, all statuses. Fleet expansion requires the route's
 * authenticated actingAsAdmin bit. Do not substitute isAdmin: opting in is intentional.
 */
export async function readTreeInventory(
  userId: string,
  fleet: boolean,
  sharing: boolean,
): Promise<TreeInventory> {
  const db = requirePlanetscaleDb();
  const [areaRows, deviceRows, dashboardRows, records] = await Promise.all([
    db
      .select({
        id: areas.id,
        name: areas.name,
        ownerId: areas.ownerUserId,
        status: areas.status,
      })
      .from(areas)
      .where(fleet ? undefined : eq(areas.ownerUserId, userId)),
    db
      .select({
        id: devices.id,
        handle: devices.rid,
        name: devices.name,
        vendor: devices.vendor,
        status: devices.status,
        ownerId: devices.ownerUserId,
        areaId: devices.areaId,
      })
      .from(devices)
      .where(fleet ? undefined : eq(devices.ownerUserId, userId)),
    db
      .select({
        id: dashboards.id,
        name: dashboards.name,
        ownerId: dashboards.ownerUserId,
        doc: dashboards.doc,
      })
      .from(dashboards)
      .where(fleet ? undefined : eq(dashboards.ownerUserId, userId)),
    listReadableDerivations(userId, fleet),
  ]);
  const areaIds = areaRows.map((a) => a.id);
  const deviceIds = deviceRows.map((d) => d.id);
  const dashboardIds = dashboardRows.map((d) => d.id);
  const visibleRecords = records.filter(
    (r) => fleet || r.devices.every((d) => deviceIds.includes(d.uuid)),
  );
  const derivationIds = visibleRecords.map((r) => r.row.id);
  const [
    pointRows,
    bindingRows,
    automationRows,
    batteryRows,
    flowRows,
    states,
    intervalRows,
    intervalProvenance,
  ] = await Promise.all([
    deviceIds.length
      ? db
          .select({
            id: points.id,
            deviceId: points.deviceId,
            name: points.name,
            path: points.physicalPath,
            metric: points.metricType,
            unit: points.unit,
            active: points.active,
            control: sql<boolean>`${points.control} is not null`,
          })
          .from(points)
          .where(inArray(points.deviceId, deviceIds))
      : [],
    areaIds.length
      ? db
          .select({
            id: areaBindings.id,
            areaId: areaBindings.areaId,
            role: areaBindings.role,
            metric: areaBindings.metricType,
            pointId: areaBindings.pointUid,
            priority: areaBindings.priority,
          })
          .from(areaBindings)
          .where(inArray(areaBindings.areaId, areaIds))
      : [],
    areaIds.length
      ? db
          .select({
            id: automations.id,
            areaId: automations.areaId,
            name: automations.name,
            enabled: automations.enabled,
            mode: automations.mode,
            trigger: automations.trigger,
            action: automations.action,
            lastTriggered: automations.lastTriggeredAt,
          })
          .from(automations)
          .where(inArray(automations.areaId, areaIds))
      : [],
    areaIds.length
      ? db
          .select({
            areaId: batteryProvenanceDaily.areaId,
            days: sql<number>`count(*)::int`,
            lastDay: sql<string | null>`max(${batteryProvenanceDaily.day})`,
          })
          .from(batteryProvenanceDaily)
          .where(inArray(batteryProvenanceDaily.areaId, areaIds))
          .groupBy(batteryProvenanceDaily.areaId)
      : [],
    areaIds.length
      ? db
          .select({
            areaId: pointReadingsFlowAttr1d.areaId,
            days: sql<number>`count(distinct ${pointReadingsFlowAttr1d.day})::int`,
            lastDay: sql<string | null>`max(${pointReadingsFlowAttr1d.day})`,
          })
          .from(pointReadingsFlowAttr1d)
          .where(inArray(pointReadingsFlowAttr1d.areaId, areaIds))
          .groupBy(pointReadingsFlowAttr1d.areaId)
      : [],
    deviceIds.length
      ? db
          .select({
            deviceId: deviceState.deviceId,
            lastSuccess: deviceState.lastSuccessTime,
          })
          .from(deviceState)
          .where(inArray(deviceState.deviceId, deviceIds))
      : [],
    derivationIds.length
      ? db
          .select({
            id: derivedIntervals.derivationId,
            count: sql<number>`count(*)::int`,
            latest: sql<Date | null>`max(${derivedIntervals.startTime})`,
          })
          .from(derivedIntervals)
          .where(inArray(derivedIntervals.derivationId, derivationIds))
          .groupBy(derivedIntervals.derivationId)
      : [],
    derivationIds.length && areaIds.length
      ? db
          .select({
            id: derivedIntervalProvenance.derivationId,
            areaId: derivedIntervalProvenance.areaId,
            count: sql<number>`count(*)::int`,
          })
          .from(derivedIntervalProvenance)
          .where(
            and(
              inArray(derivedIntervalProvenance.derivationId, derivationIds),
              inArray(derivedIntervalProvenance.areaId, areaIds),
            ),
          )
          .groupBy(
            derivedIntervalProvenance.derivationId,
            derivedIntervalProvenance.areaId,
          )
      : [],
  ]);
  const histories = new Map<
    string,
    Awaited<ReturnType<typeof ReadingsDao.agg1dSpanForDevice>>
  >();
  // Sequential per-device daily probes bound database pressure for fleet inventories.
  for (const d of deviceRows)
    histories.set(
      d.id,
      await ReadingsDao.agg1dSpanForDevice(Device.encode(d.id)),
    );
  const inventory: TreeInventory = {
    version: 1,
    generatedAt: new Date().toISOString(),
    scope: fleet ? "fleet" : "own",
    sharingIncluded: sharing,
    users: [],
    warnings: [],
    areas: areaRows.map((a) => ({
      ...a,
      id: Area.encode(a.id),
      provenance: {
        batteryDays: batteryRows.find((r) => r.areaId === a.id)?.days ?? 0,
        batteryLastDay:
          batteryRows.find((r) => r.areaId === a.id)?.lastDay ?? null,
        flowDays: flowRows.find((r) => r.areaId === a.id)?.days ?? 0,
        flowLastDay: flowRows.find((r) => r.areaId === a.id)?.lastDay ?? null,
      },
    })),
    devices: deviceRows.map((d) => ({
      ...d,
      id: Device.encode(d.id),
      areaId: d.areaId ? Area.encode(d.areaId) : null,
      history: {
        daily: histories.get(d.id) ?? null,
        lastSuccess:
          states.find((s) => s.deviceId === d.id)?.lastSuccess?.toISOString() ??
          null,
      },
    })),
    points: pointRows.map((p) => ({
      ...p,
      id: Point.encode(p.id),
      deviceId: Device.encode(p.deviceId),
    })),
    bindings: bindingRows.map((b) => ({
      ...b,
      id: Binding.encode(b.id),
      areaId: Area.encode(b.areaId),
      pointId: Point.encode(b.pointId),
    })),
    automations: automationRows.map((a) => {
      const t = parseAutomationTrigger(a.trigger);
      const action = parseAutomationAction(a.action);
      return {
        id: Automation.encode(a.id),
        areaId: Area.encode(a.areaId),
        name: a.name,
        enabled: a.enabled,
        mode: a.mode,
        trigger: t.ok
          ? `${t.value.kind} → ${t.value.source.kind === "derivation" ? Derivation.encode(t.value.source.derivationId) : Point.encode(t.value.source.pointId)}`
          : "Invalid stored trigger",
        action: action.ok
          ? `${action.value.action} → ${Point.encode(action.value.pointId)}${action.value.action === "set_value" ? ` = ${action.value.value}` : ""}`
          : "Invalid stored action",
        lastTriggered: a.lastTriggered?.toISOString() ?? null,
      };
    }),
    derivations: visibleRecords.map((r) => ({
      id: Derivation.encode(r.row.id),
      name: r.row.name,
      kind: r.row.kind,
      role: r.row.role,
      enabled: r.row.enabled,
      deviceIds: r.devices.map((d) => d.deviceId),
      sources: r.sources.map((s) => ({
        slot: s.slot,
        pointId: Point.encode(s.pointId),
        deviceId: Device.encode(s.deviceUuid),
      })),
      outputPointId: r.row.outputPointId
        ? Point.encode(r.row.outputPointId)
        : null,
      history: {
        intervals: intervalRows.find((x) => x.id === r.row.id)?.count ?? 0,
        latest: intervalRows.find((x) => x.id === r.row.id)?.latest
          ? new Date(
              intervalRows.find((x) => x.id === r.row.id)!.latest!,
            ).toISOString()
          : null,
        provenance: intervalProvenance
          .filter((x) => x.id === r.row.id)
          .map((x) => ({ areaId: Area.encode(x.areaId), intervals: x.count })),
      },
    })),
    dashboards: dashboardRows.map((d) => ({
      id: Dashboard.encode(d.id),
      name: d.name ?? "Unnamed dashboard",
      ownerId: d.ownerId,
      areaIds: dashboardAreaUuids({ doc: d.doc }).map((id) => Area.encode(id)),
      deviceIds: isDashboardV4(d.doc) ? [...collectRefs(d.doc).devices] : [],
    })),
  };
  if (sharing) {
    const now = new Date();
    // Select counts, never token values. Expired/revoked links must not look live.
    const [grants, links, calendars] = await Promise.all([
      dashboardIds.length
        ? db
            .select({
              dashboardId: dashboardGrants.dashboardId,
              userId: dashboardGrants.userId,
              role: dashboardGrants.role,
            })
            .from(dashboardGrants)
            .where(inArray(dashboardGrants.dashboardId, dashboardIds))
        : [],
      dashboardIds.length
        ? db
            .select({
              dashboardId: shareTokens.dashboardId,
              count: sql<number>`count(*)::int`,
            })
            .from(shareTokens)
            .where(
              and(
                inArray(shareTokens.dashboardId, dashboardIds),
                isNull(shareTokens.revokedAt),
                or(
                  isNull(shareTokens.expiresAt),
                  gt(shareTokens.expiresAt, now),
                ),
              ),
            )
            .groupBy(shareTokens.dashboardId)
        : [],
      areaIds.length
        ? db
            .select({
              areaId: areaCalendarTokens.areaId,
              count: sql<number>`count(*)::int`,
            })
            .from(areaCalendarTokens)
            .where(
              and(
                inArray(areaCalendarTokens.areaId, areaIds),
                isNull(areaCalendarTokens.revokedAt),
                or(
                  isNull(areaCalendarTokens.expiresAt),
                  gt(areaCalendarTokens.expiresAt, now),
                ),
              ),
            )
            .groupBy(areaCalendarTokens.areaId)
        : [],
    ]);
    inventory.sharing = {
      dashboards: [],
      calendars: calendars.map((c) => ({
        areaId: Area.encode(c.areaId),
        activeLinks: c.count,
      })),
    };
    for (const dashboard of dashboardRows) {
      const recipients = grants
        .filter((g) => g.dashboardId === dashboard.id)
        .map((g) => ({ userId: g.userId, role: g.role }));
      const activeLinks =
        links.find((l) => l.dashboardId === dashboard.id)?.count ?? 0;
      if (!recipients.length && !activeLinks) continue;
      // Use the very same scope resolver as sharing authorization; membership alone is insufficient.
      const handles = new Set(await allowedSystemIds({ doc: dashboard.doc }));
      inventory.sharing.dashboards.push({
        id: Dashboard.encode(dashboard.id),
        recipients,
        activeLinks,
        areaIds: dashboardAreaUuids({ doc: dashboard.doc })
          .filter((id) => areaIds.includes(id))
          .map((id) => Area.encode(id)),
        deviceIds: deviceRows
          .filter((d) => handles.has(d.handle))
          .map((d) => Device.encode(d.id)),
      });
    }
  }
  const clerk = await clerkClient();
  const identities = new Map<string, TreeInventory["users"][number]>();
  if (fleet) {
    for (let offset = 0; ; offset += 100) {
      const page = await clerk.users.getUserList({ limit: 100, offset });
      for (const u of page.data)
        identities.set(u.id, {
          id: u.id,
          name:
            [u.firstName, u.lastName].filter(Boolean).join(" ") ||
            u.username ||
            u.id,
          email:
            u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)
              ?.emailAddress ??
            u.emailAddresses[0]?.emailAddress ??
            null,
        });
      if (offset + page.data.length >= page.totalCount || !page.data.length)
        break;
    }
  } else {
    const u = await clerk.users.getUser(userId);
    identities.set(u.id, {
      id: u.id,
      name:
        [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        u.username ||
        u.id,
      email: u.emailAddresses[0]?.emailAddress ?? null,
    });
  }
  for (const id of new Set([
    ...areaRows.map((a) => a.ownerId),
    ...deviceRows.map((d) => d.ownerId),
    ...dashboardRows.map((d) => d.ownerId),
  ])) {
    if (id && !identities.has(id))
      identities.set(id, { id, name: id, email: null });
  }
  inventory.users = [...identities.values()];
  for (const share of inventory.sharing?.dashboards ?? []) {
    for (const recipient of share.recipients) {
      const known = identities.get(recipient.userId);
      if (known) recipient.label = known.email ?? known.name;
      else {
        try {
          const u = await clerk.users.getUser(recipient.userId);
          recipient.label =
            u.emailAddresses[0]?.emailAddress ?? u.username ?? u.id;
        } catch {
          recipient.label = recipient.userId;
          inventory.warnings.push(
            `Could not resolve sharing recipient ${recipient.userId}; showing their id.`,
          );
        }
      }
    }
  }
  if (!fleet)
    inventory.warnings.push(
      "Own inventory only; use --admin for every owner, public objects and cross-owner dependencies.",
    );
  if (sharing && !fleet)
    inventory.warnings.push(
      "Sharing annotations cover owned dashboards and area calendars; use --admin for a fleet-wide sharing audit.",
    );
  return inventory;
}
