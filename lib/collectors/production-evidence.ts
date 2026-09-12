export interface ProductionReadEvidence {
  version: 1;
  source: string;
  durationMs: number;
  ok: boolean;
  incident?: "session-evicted" | "connection-disruption";
}
function incident(error: unknown): ProductionReadEvidence["incident"] {
  const e = error as
    | { status?: number; code?: string; errorCode?: string }
    | undefined;
  return e?.status === 401 || e?.errorCode === "401"
    ? "session-evicted"
    : e?.code === "ECONNRESET" || e?.code === "ECONNREFUSED"
      ? "connection-disruption"
      : undefined;
}
/** The callback is diagnostic: it must never alter the production fetch result. */
export async function measureProductionRead<T extends { success: boolean }>(
  source: string,
  fetch: () => Promise<T>,
  record: (e: ProductionReadEvidence) => void,
): Promise<T> {
  const start = performance.now();
  const emit = (ok: boolean, error?: unknown) => {
    try {
      record({
        version: 1,
        source,
        durationMs: performance.now() - start,
        ok,
        incident: incident(error),
      });
    } catch {
      /* collection has priority */
    }
  };
  try {
    const result = await fetch();
    emit(result.success, result);
    return result;
  } catch (error) {
    emit(false, error);
    throw error;
  }
}
export function attachProductionEvidence(
  raw: unknown,
  evidence?: ProductionReadEvidence,
) {
  if (!evidence) return raw;
  return {
    ...(raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : { raw }),
    gousherTrialRead: evidence,
  };
}
export function summarizeProductionEvidence(
  source: string,
  rows: Array<{ at: Date; response: unknown; duration?: number }>,
  start: Date,
  end: Date,
  allowEmpty = false,
) {
  const durations: number[] = [];
  let failures = 0;
  const incidents: Array<{ at: string; reason: string }> = [];
  for (const row of rows) {
    if (+row.at < +start || +row.at >= +end) continue;
    const raw = row.response as {
      gousherTrialRead?: ProductionReadEvidence;
    } | null;
    const e = raw?.gousherTrialRead;
    if (!e) continue; // Historical/backfill sessions are not read timing evidence.
    if (
      e.version !== 1 ||
      e.source !== source ||
      typeof e.ok !== "boolean" ||
      !Number.isFinite(e.durationMs) ||
      e.durationMs < 0
    )
      throw Error("Invalid production read evidence");
    durations.push(e.durationMs);
    if (!e.ok) failures++;
    if (e.incident) {
      if (
        e.incident !== "session-evicted" &&
        e.incident !== "connection-disruption"
      )
        throw Error("Invalid production incident");
      incidents.push({ at: row.at.toISOString(), reason: e.incident });
    }
  }
  if (!durations.length && allowEmpty) return { metrics: null, incidents };
  if (!durations.length)
    throw Error("No measured production reads; enable evidence capture first");
  durations.sort((a, b) => a - b);
  return {
    metrics: {
      samples: durations.length,
      failureRate: failures / durations.length,
      p95ReadMs: durations[Math.ceil(durations.length * 0.95) - 1],
    },
    incidents,
  };
}
