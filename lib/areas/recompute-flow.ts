/**
 * Client helper: drive the batched single-area Sankey recompute (`POST
 * /api/areas/[id]/recompute-provenance`) to completion. That endpoint materialises the attributed flow
 * matrix (`point_readings_flow_attr_1d`, the Sankey source since flow_1d was retired) a bounded batch
 * per call and returns a `nextCursor`; this loops on it until `done`, so a long range can't blow the
 * function timeout. Owner/admin auth is carried by the session cookie. `onProgress` reports the running
 * day count for a live status line.
 */
export async function recomputeAreaFlow(
  areaId: string,
  onProgress?: (daysSoFar: number) => void,
): Promise<{ recomputed: number; systemId: number | null }> {
  let cursor: string | undefined;
  let total = 0;
  let systemId: number | null = null;
  // Safety cap: well above any real range (≈ MAX_LIMIT 31 × 200 = 6200 days) so a bug can't spin forever.
  for (let i = 0; i < 200; i++) {
    const res = await fetch(
      `/api/areas/${encodeURIComponent(areaId)}/recompute-provenance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cursor ? { cursor } : {}),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? `Recompute failed (${res.status})`);
    }
    const data = await res.json();
    if (typeof data.systemId === "number") systemId = data.systemId;
    total += data.recomputed ?? 0;
    onProgress?.(total);
    if (data.done || !data.nextCursor) break;
    cursor = data.nextCursor as string;
  }
  // `systemId` is the area's handle — the key the chart/sankey queries use; the caller invalidates it so
  // the freshly-recomputed Sankey shows without a hard refresh (the data is otherwise long-`staleTime`d).
  return { recomputed: total, systemId };
}
