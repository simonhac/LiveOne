#!/usr/bin/env tsx
/**
 * Pre-mint permanent config-v4 device ids and fill legacy area handles.
 *
 * Dry-run is the default. Pass --commit explicitly to write. The operation is idempotent: existing
 * device/area ids are preserved, including a row whose integer handle legitimately names both.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { Device, isCanonicalUuid } from "@/lib/ids";

async function inspect() {
  const { requirePlanetscaleDb } = await import("@/lib/db/planetscale");
  const { systems, areas, areaBindings, legacyHandles } = await import(
    "@/lib/db/planetscale/schema"
  );
  const db = requirePlanetscaleDb();
  const [systemRows, areaRows, handleRows, bindingRows] = await Promise.all([
    db.select({ handle: systems.id, config: systems.config }).from(systems),
    db
      .select({
        handle: areas.legacySystemId,
        areaId: areas.id,
        config: areas.config,
      })
      .from(areas)
      .where(isNotNull(areas.legacySystemId)),
    db
      .select({
        handle: legacyHandles.handle,
        deviceId: legacyHandles.deviceId,
        areaId: legacyHandles.areaId,
      })
      .from(legacyHandles),
    db
      .select({
        areaId: areaBindings.areaId,
        systemId: areaBindings.pointSystemId,
        ordinal: areaBindings.ordinal,
      })
      .from(areaBindings)
      .where(
        and(
          eq(areaBindings.role, "battery"),
          eq(areaBindings.metricType, "power"),
        ),
      )
      .orderBy(
        asc(areaBindings.areaId),
        asc(areaBindings.ordinal),
        asc(areaBindings.id),
      ),
  ]);
  return {
    db,
    systemRows,
    areaRows: areaRows.filter(
      (
        r,
      ): r is {
        handle: number;
        areaId: string;
        config: typeof r.config;
      } => r.handle != null,
    ),
    handleRows,
    bindingRows,
  };
}

function isUuidV7(value: string): boolean {
  return (
    isCanonicalUuid(value) &&
    value[14]?.toLowerCase() === "7" &&
    /^[89ab]$/i.test(value[19] ?? "")
  );
}

async function main() {
  const commit = process.argv.includes("--commit");
  const before = await inspect();
  const byHandle = new Map(before.handleRows.map((r) => [r.handle, r]));
  const missingDevices = before.systemRows.filter(
    (s) => !byHandle.get(s.handle)?.deviceId,
  );
  const missingAreas = before.areaRows.filter(
    (a) => !byHandle.get(a.handle)?.areaId,
  );
  const deviceCandidates = new Map(
    missingDevices.map((row) => [row.handle, Device.generate()] as const),
  );
  const plannedByHandle = new Map(
    before.handleRows.map((row) => [row.handle, { ...row }]),
  );
  for (const row of missingDevices) {
    const current = plannedByHandle.get(row.handle) ?? {
      handle: row.handle,
      deviceId: null,
      areaId: null,
    };
    current.deviceId = Device.toUuid(deviceCandidates.get(row.handle)!);
    plannedByHandle.set(row.handle, current);
  }
  for (const row of missingAreas) {
    const current = plannedByHandle.get(row.handle) ?? {
      handle: row.handle,
      deviceId: null,
      areaId: null,
    };
    current.areaId = row.areaId;
    plannedByHandle.set(row.handle, current);
  }
  const plannedRows = [...plannedByHandle.values()];
  const plannedDeviceIds = plannedRows
    .map((row) => row.deviceId)
    .filter((id): id is string => id != null);
  const plannedAreaIds = plannedRows
    .map((row) => row.areaId)
    .filter((id): id is string => id != null);
  const validationErrors = [
    ...before.systemRows
      .filter((row) => plannedByHandle.get(row.handle)?.deviceId == null)
      .map((row) => `system ${row.handle} has no planned device id`),
    ...before.areaRows
      .filter((row) => plannedByHandle.get(row.handle)?.areaId !== row.areaId)
      .map((row) => `area ${row.areaId} has a conflicting handle mapping`),
    ...plannedDeviceIds
      .filter((id) => !isUuidV7(id))
      .map((id) => `device id is not a canonical UUIDv7: ${id}`),
    ...plannedAreaIds
      .filter((id) => !isCanonicalUuid(id))
      .map((id) => `area id is not a canonical UUID: ${id}`),
    ...(new Set(plannedDeviceIds).size === plannedDeviceIds.length
      ? []
      : ["planned device ids are not unique"]),
    ...(new Set(plannedAreaIds).size === plannedAreaIds.length
      ? []
      : ["planned area ids are not unique"]),
  ];
  const systemConfig = new Map(
    before.systemRows.map((row) => [row.handle, row.config]),
  );
  const areaConfigBackfills = before.areaRows.flatMap((area) => {
    const current = area.config;
    if (current?.batteryProvenance) return [];
    const bound = before.bindingRows
      .filter((binding) => binding.areaId === area.areaId)
      .map((binding) => binding.systemId);
    const source = bound[0];
    const batteryProvenance =
      source == null ? undefined : systemConfig.get(source)?.batteryProvenance;
    return batteryProvenance
      ? [
          {
            areaId: area.areaId,
            config: { ...(current ?? {}), batteryProvenance },
          },
        ]
      : [];
  });

  console.log(
    JSON.stringify(
      {
        mode: commit ? "commit" : "dry-run",
        systems: before.systemRows.length,
        areasWithHandles: before.areaRows.length,
        missingDevices: missingDevices.length,
        missingAreas: missingAreas.length,
        validationErrors,
        areaConfigsToBackfill: areaConfigBackfills.length,
        sharedAreaDeviceHandles: before.areaRows.filter((a) =>
          before.systemRows.some((s) => s.handle === a.handle),
        ).length,
      },
      null,
      2,
    ),
  );
  if (validationErrors.length > 0)
    throw new Error(
      `Foundation validation failed:\n${validationErrors.join("\n")}`,
    );
  if (!commit) {
    console.log("Dry-run only; rerun with --commit to write mappings.");
    return;
  }

  const { DeviceRegistry } = await import("@/lib/registry");
  await before.db.transaction(async (tx) => {
    for (const row of missingDevices) {
      await DeviceRegistry.ensureDeviceForHandle(
        row.handle,
        tx,
        deviceCandidates.get(row.handle)!,
      );
    }
    for (const row of missingAreas) {
      await DeviceRegistry.ensureAreaForHandle(row.handle, row.areaId, tx);
    }
    const { areas } = await import("@/lib/db/planetscale/schema");
    for (const row of areaConfigBackfills) {
      await tx
        .update(areas)
        .set({ config: row.config })
        .where(eq(areas.id, row.areaId));
    }
  });

  const after = await inspect();
  const afterByHandle = new Map(after.handleRows.map((r) => [r.handle, r]));
  const deviceGaps = after.systemRows.filter(
    (s) => !afterByHandle.get(s.handle)?.deviceId,
  );
  const areaGaps = after.areaRows.filter(
    (a) => afterByHandle.get(a.handle)?.areaId !== a.areaId,
  );
  const deviceIds = after.handleRows
    .map((r) => r.deviceId)
    .filter((id): id is string => id != null);
  const areaIds = after.handleRows
    .map((r) => r.areaId)
    .filter((id): id is string => id != null);
  if (
    deviceGaps.length > 0 ||
    areaGaps.length > 0 ||
    deviceIds.some((id) => !isUuidV7(id)) ||
    areaIds.some((id) => !isCanonicalUuid(id)) ||
    new Set(deviceIds).size !== deviceIds.length ||
    new Set(areaIds).size !== areaIds.length
  ) {
    throw new Error(
      `Backfill verification failed: device gaps=${deviceGaps.length}, area gaps=${areaGaps.length}`,
    );
  }
  console.log(
    `Verified ${deviceIds.length} device mappings and ${areaIds.length} area mappings.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
