/**
 * Client helper: drive the batched single-area Sankey recompute (`POST /api/areas/[id]/recompute-flow`)
 * to completion. The endpoint does a bounded batch per call and returns a `nextCursor`; this loops on it
 * until `done`, so a long range can't blow the function timeout. Owner/admin auth is carried by the
 * session cookie. `onProgress` reports the running day count for a live status line.
 */
export async function recomputeAreaFlow(
  areaId: string,
  onProgress?: (daysSoFar: number) => void,
): Promise<{ recomputed: number }> {
  let cursor: string | undefined;
  let total = 0;
  // Safety cap: well above any real range (≈ MAX_LIMIT 31 × 200 = 6200 days) so a bug can't spin forever.
  for (let i = 0; i < 200; i++) {
    const res = await fetch(
      `/api/areas/${encodeURIComponent(areaId)}/recompute-flow`,
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
    total += data.recomputed ?? 0;
    onProgress?.(total);
    if (data.done || !data.nextCursor) break;
    cursor = data.nextCursor as string;
  }
  return { recomputed: total };
}
