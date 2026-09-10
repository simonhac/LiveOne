/**
 * Register the derived hot-water temperature point for a device, and the `derivations` row that
 * turns it on.
 *
 * The modelled faucet temperature lives in the generic readings device as a normal `point_info`
 * row (`load.hws/temperature`, °C). Since config-v4 Phase 11 the point alone no longer enables
 * modelling — an `output='point'`, `kind='hws-model'` derivation naming it does (that is what
 * lib/hws/recompute.ts discovers). Both steps are idempotent; a device still needs a sibling
 * `load.hws/power` point to model from.
 */
import { and, eq } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { derivations, devices, points } from "@/lib/db/planetscale/schema";
import { findPointByStemMetric, mintPoint } from "@/lib/point/mint-point";
import { refreshServingForMintedPoints } from "@/lib/kv-cache-manager";
import { deriveDerivationId } from "@/lib/derivations/ids";
import { HWS_MODEL_KIND } from "@/lib/derivations/resolve";
import {
  findDerivationBySource,
  writeDerivationSources,
} from "@/lib/derivations/sources";

const HWS_STEM = "load.hws";
const TEMP_PHYSICAL_PATH = "derived/load.hws/temperature"; // synthetic, unique per device
const TEMP_UNIT = "°C";
const TEMP_DISPLAY_NAME = "Hot Water";

export interface EnsureResult {
  status: "created" | "exists" | "no-power-point";
  systemId: number;
  tempPointId?: number;
  powerPointId?: number;
}

/**
 * Ensure a `load.hws/temperature` point exists for `systemId`. Idempotent: returns the existing
 * point if present, creates it (next index) otherwise, and refuses if the device has no
 * `load.hws/power` signal point. When `apply` is false, reports what it would do without writing.
 */
export async function ensureHwsTemperaturePoint(
  systemId: number,
  apply: boolean,
): Promise<EnsureResult> {
  const db = requirePlanetscaleDb();

  const [power] = await db
    .select({ index: points.rid })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(devices.rid, systemId),
        eq(points.logicalPath, HWS_STEM),
        eq(points.metricType, "power"),
        eq(points.active, true),
      ),
    )
    .limit(1);
  if (!power) return { status: "no-power-point", systemId };

  const existing = await findPointByStemMetric(
    systemId,
    HWS_STEM,
    "temperature",
  );
  if (existing) {
    return {
      status: "exists",
      systemId,
      // `rid` — the global point id. Since the terminal window `findPointByStemMetric` reads
      // `points ⋈ devices`, where `index` IS `rid` (one column, two names), so the two are equal by
      // construction rather than by mirror. Naming `rid` keeps the field that survives.
      tempPointId: existing.rid,
      powerPointId: power.index,
    };
  }

  if (!apply) {
    return { status: "created", systemId, powerPointId: power.index };
  }

  // config-v4 slice M: identity + index come from `mintPoint` (points-primary). The local
  // max(index)+1 scan this replaced also never mirrored into `points`, so it was a live C7 hole.
  const row = await mintPoint(systemId, {
    physicalPathTail: TEMP_PHYSICAL_PATH,
    logicalPathStem: HWS_STEM,
    metricType: "temperature",
    metricUnit: TEMP_UNIT,
    defaultName: TEMP_DISPLAY_NAME,
  });
  // A fresh mint is absent from the KV serving registry, so its value would reach the device hash
  // but no Area hash until an unrelated area mutation rebuilt the registry.
  await refreshServingForMintedPoints("hws/ensureHwsTemperaturePoint");

  return {
    status: "created",
    systemId,
    tempPointId: row.index,
    powerPointId: power.index,
  };
}

export interface EnsureDerivationResult {
  status: "created" | "exists" | "no-points";
  systemId: number;
  derivationId?: string;
}

/**
 * Ensure the `hws-model` derivation for `systemId` exists, wiring the power point (source) to the
 * temperature point (output). Idempotent via the deterministic id — safe to re-run, and it upserts
 * the wiring rather than duplicating. Requires {@link ensureHwsTemperaturePoint} to have run.
 */
export async function ensureHwsDerivation(
  systemId: number,
  apply: boolean,
): Promise<EnsureDerivationResult> {
  const db = requirePlanetscaleDb();

  const pts = await db
    .select({
      metricType: points.metricType,
      pointUid: points.id,
      displayName: points.name,
    })
    .from(points)
    .innerJoin(devices, eq(devices.id, points.deviceId))
    .where(
      and(
        eq(devices.rid, systemId),
        eq(points.logicalPath, HWS_STEM),
        eq(points.active, true),
      ),
    );
  const power = pts.find((p) => p.metricType === "power");
  const temp = pts.find((p) => p.metricType === "temperature");
  if (!power || !temp) return { status: "no-points", systemId };

  // Existence by NATURAL KEY (`derivation_sources`), not by minting the id and looking it up — see
  // `ensureRunDetector` and `lib/derivations/ids.ts` for why that inversion matters.
  const existingId = await findDerivationBySource(
    db,
    HWS_MODEL_KIND,
    null,
    "power",
    power.pointUid,
  );
  if (existingId)
    return { status: "exists", systemId, derivationId: existingId };

  // Anchored on the POWER POINT uuid rather than the area: deterministic and cross-environment
  // stable (`points.id` is a uuidv5). Minted on the insert path only.
  const id = deriveDerivationId(power.pointUid, HWS_MODEL_KIND, null);
  if (!apply) return { status: "created", systemId, derivationId: id };

  // 🛑 BOTH WRITES OR NEITHER — see the same note in `ensureRunDetector`. A parent with no source
  // row is invisible to `findDerivationBySource`, so the retry re-mints the same deterministic id
  // and dies on the primary key.
  await db.transaction(async (tx) => {
    await tx.insert(derivations).values({
      id,
      // 🛑 NULL — see the same note in `ensureRunDetector`. `area_id` is a vestige 0064 drops, and
      // the model's site is its power point's device.
      areaId: null,
      kind: HWS_MODEL_KIND,
      role: null,
      name: temp.displayName,
      enabled: true,
      output: "point",
      outputPointId: temp.pointUid,
      // Sparse: the model runs on DEFAULT_HWS_MODEL_OPTIONS unless a constant is overridden here.
      params: {},
      // Dual-written with the `derivation_sources` row below; the resolver reads only the latter.
      sourcePoints: { power: power.pointUid },
    });
    await writeDerivationSources(tx, {
      derivationId: id,
      kind: HWS_MODEL_KIND,
      role: null,
      slots: { power: power.pointUid },
    });
  });

  return { status: "created", systemId, derivationId: id };
}
