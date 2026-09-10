/**
 * Area wiring: wire shapes, loading, reference resolution, and the pure slot rewrite.
 *
 * Everything here is decision-making — nothing prints and nothing writes. `rewriteSlot` in
 * particular is the step whose failure is SILENT (see `index.ts`), so it lives as a pure exported
 * function that a test can exercise directly.
 */
import { EXIT, failWith } from "@/lib/cli/cli";
import { type ApiSession } from "@/lib/cli-kit/api-session";
import { resolveRef } from "../../shared";

export interface WireMember {
  id: string;
  legacySystemId: number | null;
  name: string;
  vendor: string;
  status: string;
  capabilities?: string[];
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
): Promise<Aggregate> {
  const { areas } = await s.get<{
    areas: Array<{
      id: string | null;
      displayName: string;
      legacySystemId: number | null;
    }>;
  }>("/api/v4/areas");
  const area = resolveRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
    { noun: "area", listCmd: "liveone area list" },
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

/**
 * Every point on every member device, which is exactly the pool a binding may draw from.
 *
 * 🛑 `?include=points` is REQUIRED — the device aggregate omits points without it, and returns 200
 * either way. Dropping it does not fail: it yields an empty pool, which turns every `role set` into
 * "no point matching …" and every `role list` into a wall of raw `pt_` ids. So an empty pool from a
 * non-empty membership is treated as the bug it is, rather than as an area with nothing to bind.
 */
export async function loadPointPool(
  s: ApiSession,
  members: WireMember[],
): Promise<PointCandidate[]> {
  const pool: PointCandidate[] = [];
  for (const m of members) {
    const dev = await s.get<{ name: string; points?: WirePoint[] }>(
      `/api/v4/devices/${encodeURIComponent(m.id)}?include=points`,
    );
    for (const p of dev.points ?? [])
      pool.push({ ...p, deviceId: m.id, deviceName: dev.name ?? m.name });
  }
  if (members.length && !pool.length)
    throw failWith(
      EXIT.UPSTREAM,
      `${members.length} member device(s) reported no points at all`,
      "that is not a wiring state this CLI can act on — every area has points somewhere",
      "check `liveone device points <device>`; if that works, this loader lost its ?include=points",
    );
  return pool;
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

export async function resolveDevices(
  s: ApiSession,
  refs: string[],
): Promise<WireMember[]> {
  const { devices } = await s.get<{ devices: WireMember[] }>("/api/v4/devices");
  return refs.map((r) =>
    resolveRef(devices, r, {
      noun: "device",
      listCmd: "liveone device list",
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
