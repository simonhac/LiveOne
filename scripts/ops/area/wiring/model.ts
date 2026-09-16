/**
 * Area wiring: wire shapes, loading, reference resolution, and the pure slot rewrite.
 *
 * Everything here is decision-making — nothing prints and nothing writes. `rewriteSlot` in
 * particular is the step whose failure is SILENT (see `index.ts`), so it lives as a pure exported
 * function that a test can exercise directly.
 */
import { CliFailure, EXIT, failWith } from "@/lib/cli/cli";
import { type ApiSession } from "@/lib/cli-kit/api-session";
import { resolveRef } from "../../shared";

export interface WireMember {
  id: string;
  legacySystemId: number | null;
  name: string;
  vendor: string;
  status: string;
  capabilities?: string[];
  /**
   * The area this device is CURRENTLY in, as `GET /api/v4/devices` reports it. Present on a
   * candidate from that list, absent on a member read out of the area aggregate (which already knows
   * the answer). `null` means ambient.
   */
  areaId?: string | null;
  areaName?: string | null;
}

export interface WireBinding {
  id?: string;
  role: string;
  metricType: string;
  pointId: string;
  priority: number;
  transform: string | null;
}

export interface WirePoint {
  id: string;
  logicalPath: string;
  metricType: string;
  unit: string | null;
  name: string;
}

/** A point offered to `area role set`, tagged with the member device that owns it. */
export interface PointCandidate extends WirePoint {
  deviceId: string;
  deviceName: string;
}

export interface Aggregate {
  area: { id: string; name: string };
  members: WireMember[];
  bindings: WireBinding[];
}

/**
 * 🛑 A `vendor: "helper"` member is SERVER-MANAGED — the battery-provenance writer mints it and
 * binds the blend points onto it. `replaceMembers` refuses to evict one by omission, but an
 * operator reading a device list and typing it back would still be surprised to see a device they
 * never added, so these verbs mark it rather than hiding it.
 */
export const isHelper = (m: WireMember) => m.vendor === "helper";

export async function loadAggregate(
  s: ApiSession,
  ref: string,
  opts: { includeArchived?: boolean } = {},
): Promise<Aggregate> {
  // 🛑 `includeArchived` reaches HERE, not only the route. A ref is matched against the LIST
  // (`resolveRef`), so an area the list omits is unaddressable — including by its literal `ar_` id.
  // Without it the wiring verbs could not name an archived area at all, which is the one state you
  // most need them in: retiring an area is archive → clear what it holds → delete, and the middle
  // step was unreachable. Found while trying to retire an area whose helper device blocked it.
  const { areas } = await s.get<{
    areas: Array<{
      id: string | null;
      displayName: string;
      legacySystemId: number | null;
    }>;
  }>(
    opts.includeArchived
      ? "/api/v4/areas?includeArchived=true"
      : "/api/v4/areas",
  );
  const area = resolveRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
    {
      noun: "area",
      listCmd: opts.includeArchived
        ? "liveone area list --include-archived"
        : "liveone area list",
    },
  );
  const body = await s.get<{
    area: { id: string; name: string };
    members: WireMember[];
    bindings: WireBinding[];
  }>(`/api/v4/areas/${encodeURIComponent(area.id!)}`);
  return {
    area: { id: body.area.id, name: body.area.name },
    members: body.members ?? [],
    bindings: body.bindings ?? [],
  };
}

/** A member whose points could not be fetched, so the pool is missing them. */
export interface UnreadableMember {
  deviceId: string;
  name: string;
  reason: string;
}

/** The point pool, plus whichever members did not contribute to it. */
export interface PointPool {
  points: PointCandidate[];
  unreadable: UnreadableMember[];
}

/**
 * Every point on every member device, which is exactly the pool a binding may draw from.
 *
 * 🛑 `?include=points` is REQUIRED — the device aggregate omits points without it, and returns 200
 * either way. Dropping it does not fail: it yields an empty pool, which turns every `role set` into
 * "no point matching …" and every `role list` into a wall of raw `pt_` ids. So an empty pool from a
 * non-empty membership is treated as the bug it is, rather than as an area with nothing to bind.
 *
 * 🛑 `includeInactive=true`, and a per-member failure is RECORDED rather than thrown. An area
 * aggregate returns its non-active members (`lib/areas/v4-shapes.ts` says so explicitly), while the
 * per-device route is `activeOnly` — so this loop used to 404 on the first retired member and take
 * the whole verb down with it. `liveone area role list` on Craig Unified, whose job is to report an
 * area's wiring, answered `error: Device not found` and exit 1: an area whose devices had been
 * retired was unreportable by the one verb that reports it, and the readable two-thirds of the
 * answer went with it. Failing OPEN is the point — the caller is told which members are missing and
 * still gets the rest.
 */
export async function loadPointPool(
  s: ApiSession,
  members: WireMember[],
): Promise<PointPool> {
  const points: PointCandidate[] = [];
  const unreadable: UnreadableMember[] = [];
  for (const m of members) {
    try {
      const dev = await s.get<{ name: string; points?: WirePoint[] }>(
        `/api/v4/devices/${encodeURIComponent(m.id)}?include=points&includeInactive=true`,
      );
      for (const p of dev.points ?? [])
        points.push({ ...p, deviceId: m.id, deviceName: dev.name ?? m.name });
    } catch (e) {
      unreadable.push({
        deviceId: m.id,
        name: m.name,
        reason:
          e instanceof CliFailure
            ? e.detail.what
            : e instanceof Error
              ? e.message
              : String(e),
      });
    }
  }
  // Unchanged in meaning, but it must not fire when every member was ACCOUNTED FOR: an area of two
  // unreadable members has an empty pool for a reason the caller has already been told, and
  // throwing here would simply move the fail-closed behaviour one line down.
  if (members.length && !points.length && !unreadable.length)
    throw failWith(
      EXIT.UPSTREAM,
      `${members.length} member device(s) reported no points at all`,
      "that is not a wiring state this CLI can act on — every area has points somewhere",
      "check `liveone device points <device>`; if that works, this loader lost its ?include=points",
    );
  return { points, unreadable };
}

/**
 * Resolve one point reference against the area's own pool.
 *
 * Accepts a `pt_` id, a bare `logicalPath`, or `device:logicalPath`. The device-qualified form is
 * not decoration: a composite area routinely has the SAME logical path on two members (a Sigenergy
 * meter and an Amber account both offer `bidi.grid.import/energy`), and picking one silently would
 * bind whichever happened to sort first.
 */
export function resolvePoint(
  pool: PointCandidate[],
  ref: string,
): PointCandidate {
  const exactId = pool.find((p) => p.id === ref);
  if (exactId) return exactId;

  const [maybeDevice, maybePath] = ref.includes(":")
    ? [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)]
    : [null, ref];

  const lc = (x: string) => x.toLowerCase();
  let candidates = pool.filter((p) => lc(p.logicalPath) === lc(maybePath));
  if (maybeDevice !== null)
    candidates = candidates.filter(
      (p) =>
        lc(p.deviceName).includes(lc(maybeDevice)) ||
        p.deviceId === maybeDevice ||
        lc(p.deviceName) === lc(maybeDevice),
    );

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0)
    throw failWith(
      EXIT.FINDINGS,
      `no point matching "${ref}" on this area's devices`,
      "a binding may only draw from points on the area's OWN member devices",
      "run `liveone area role list <area> --points` to see the pool, or add the device first with `liveone area devices add`",
    );
  throw failWith(
    EXIT.USAGE,
    `"${ref}" matches ${candidates.length} points on this area`,
    candidates.map((c) => `${c.deviceName}:${c.logicalPath}`).join(", "),
    "qualify it as `device:logicalPath`, or give the pt_ id",
  );
}

/**
 * Resolve device refs for the MEMBERSHIP verbs (`area devices add|remove|set`).
 *
 * 🛑 `includeInactive`, and it is load-bearing rather than tidy. A ref is matched against the LIST
 * (see `resolveRef`), so a device the list omits is unaddressable — including by its literal `dv_`
 * id. Without this, an ARCHIVED device that is still a member of an area could not be named, and
 * therefore could not be removed from it: `area devices remove` answered "no device matches" for the
 * one device it most needed to address. Retiring a device is remove → archive → delete, and any
 * order but that exact one dead-ended.
 *
 * Found while retiring a device whose area membership blocked its archive. Widening WHICH devices are
 * addressable, never WHOSE: the route still authorizes every one of them.
 */
export async function resolveDevices(
  s: ApiSession,
  refs: string[],
): Promise<WireMember[]> {
  const { devices } = await s.get<{ devices: WireMember[] }>(
    "/api/v4/devices?includeInactive=true",
  );
  return refs.map((r) =>
    resolveRef(devices, r, {
      noun: "device",
      listCmd: "liveone device list --include-inactive",
    }),
  );
}

/**
 * Replace ONE `(role, metric)` slot, carrying every other binding through untouched.
 *
 * 🛑 This is the whole safety property of `area role set`, and its failure is silent. The route is a
 * full replace, so returning only the new slot does not error — it deletes every other slot, and the
 * area quietly stops rendering the cards those slots fed. Priority follows ARGUMENT ORDER, mirroring
 * the route's own "ordinal = array index".
 *
 * Exported so the test exercises THIS function rather than a copy of it: a reimplementation in the
 * test would keep passing while the shipped rewrite broke.
 */
export function rewriteSlot(
  current: WireBinding[],
  role: string,
  metric: string,
  pointIds: string[],
): WireBinding[] {
  const others = current.filter(
    (b) => !(b.role === role && b.metricType === metric),
  );
  return [
    ...others,
    ...pointIds.map((pointId, i) => ({
      role,
      metricType: metric,
      pointId,
      priority: i,
      transform: null,
    })),
  ];
}
