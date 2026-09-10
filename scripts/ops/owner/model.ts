/**
 * `liveone owner` — resolving what a transfer will move, and what it will leave behind.
 *
 * Pure decisions plus reads; nothing here writes. The interesting part is `scanDocRefs`, which is
 * what makes the dry run honest about dashboards.
 */
import { EXIT, failWith } from "@/lib/cli/cli";
import { type ApiSession } from "@/lib/cli-kit/api-session";
import { resolveRef } from "../shared";
import { scanDocRefs } from "@/lib/dashboard/doc-refs";

export interface WireDeviceRow {
  id: string;
  legacySystemId: number | null;
  name: string;
  vendor?: string;
  status?: string;
  ownerUserId?: string | null;
}

export interface WireAreaRow {
  id: string | null;
  displayName: string;
  legacySystemId: number | null;
}

export interface WireDashRow {
  id: string;
  name: string | null;
  slug: string | null;
  access?: string;
}

/** What a transfer will actually send — resolved ids, plus the names to print. */
export interface TransferPlan {
  devices: Array<{ id: string; name: string; handle: number | null }>;
  areas: Array<{ id: string; name: string }>;
  dashboards: Array<{ id: string; name: string | null }>;
  /**
   * Dashboards that REFERENCE a moving device but were not named. Not auto-included — see
   * `scanDocRefs` — but never silently dropped either.
   */
  referencingNotIncluded: Array<{ id: string; name: string | null }>;
}

export async function resolveDevice(
  s: ApiSession,
  ref: string,
): Promise<WireDeviceRow> {
  const { devices } = await s.get<{ devices: WireDeviceRow[] }>(
    "/api/v4/devices",
  );
  return resolveRef(devices, ref, {
    noun: "device",
    listCmd: "liveone device list",
  });
}

export async function resolveArea(
  s: ApiSession,
  ref: string,
): Promise<WireAreaRow> {
  const { areas } = await s.get<{ areas: WireAreaRow[] }>("/api/v4/areas");
  return resolveRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
    { noun: "area", listCmd: "liveone area list" },
  );
}

export async function resolveDashboard(
  s: ApiSession,
  ref: string,
): Promise<WireDashRow> {
  const { dashboards } = await s.get<{ dashboards: WireDashRow[] }>(
    "/api/v4/dashboards",
  );
  return resolveRef(
    dashboards.map((d) => ({ ...d, name: d.name ?? d.slug ?? d.id })),
    ref,
    { noun: "dashboard", listCmd: "liveone dashboard list" },
  );
}

/** The member devices of an area — the `--cascade` expansion. */
export async function areaMemberDevices(
  s: ApiSession,
  areaId: string,
): Promise<WireDeviceRow[]> {
  const body = await s.get<{ members: WireDeviceRow[] }>(
    `/api/v4/areas/${encodeURIComponent(areaId)}`,
  );
  return body.members ?? [];
}

/**
 * Which dashboards reference any of these areas/devices?
 *
 * The walk itself is `scanDocRefs` (`lib/dashboard/doc-refs.ts`), which is where the
 * three-walkers-and-why note lives. Re-exported here so the CLI's own tests keep addressing it at
 * this path.
 *
 * 🛑 It is used to WARN, never to auto-include. A cascade that silently swept in dashboards would
 * transfer documents the operator never named, and dashboards are the thing share-back grants are
 * written against — quietly moving one changes who can see what. The interlock that makes the
 * warning safe to ignore is server-side: `transferOwnership` refuses a transfer whose share-back
 * would not restore read access, so forgetting a dashboard fails loudly rather than silently.
 */
export { scanDocRefs };

export async function dashboardsReferencing(
  s: ApiSession,
  ids: Set<string>,
): Promise<WireDashRow[]> {
  const { dashboards } = await s.get<{ dashboards: WireDashRow[] }>(
    "/api/v4/dashboards",
  );
  const hits: WireDashRow[] = [];
  for (const d of dashboards) {
    const body = await s.get<{ doc: unknown }>(
      `/api/v4/dashboards/${encodeURIComponent(d.id)}`,
    );
    const refs = scanDocRefs(body.doc);
    if ([...refs].some((r) => ids.has(r))) hits.push(d);
  }
  return hits;
}

/** `a,b , c` → `["a","b","c"]`. Empty/absent → []. */
export function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function requireSomething(plan: TransferPlan): void {
  if (!plan.devices.length && !plan.areas.length && !plan.dashboards.length)
    throw failWith(
      EXIT.USAGE,
      "nothing named to transfer",
      "give at least one of --devices, --areas or --dashboards",
      "e.g. `liveone owner transfer <user> --areas=kutis --cascade`",
    );
}
