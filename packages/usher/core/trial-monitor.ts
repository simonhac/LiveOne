/** Read-only production evidence for the independent trial supervisor. */
import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
const unzip = promisify(gunzip);
const WINDOW = 900000;
type Window = { durations: number[]; failures: number; overflow: boolean };
type Incident = {
  at: string;
  reason: "session-evicted" | "connection-disruption" | "attempted-write";
};
export class ProductionTrialMonitor {
  private windows = new Map<string, Map<number, Window>>();
  private incidents = new Map<string, Incident[]>();
  constructor(readonly startedAt = Date.now()) {}
  record(
    site: string,
    at: number,
    duration: number,
    ok: boolean,
    incident?: Incident["reason"],
  ) {
    if (!Number.isFinite(duration) || duration < 0) return;
    let windows = this.windows.get(site);
    if (!windows) {
      if (this.windows.size >= 32) return;
      windows = new Map();
      this.windows.set(site, windows);
    }
    const end = Math.floor(at / WINDOW) * WINDOW + WINDOW;
    const w = windows.get(end) ?? {
      durations: [],
      failures: 0,
      overflow: false,
    };
    if (w.durations.length >= 1024) w.overflow = true;
    else {
      w.durations.push(duration);
      if (!ok) w.failures++;
    }
    windows.set(end, w);
    for (const key of windows.keys())
      if (key < end - 96 * WINDOW) windows.delete(key);
    if (incident) {
      const events = this.incidents.get(site) ?? [];
      events.push({ at: new Date(at).toISOString(), reason: incident });
      this.incidents.set(site, events.slice(-1024));
    }
  }
  window(site: string, end: number, now: number) {
    const w = this.windows.get(site)?.get(end);
    if (
      end % WINDOW !== 0 ||
      end > now ||
      end - WINDOW < this.startedAt ||
      !w ||
      w.overflow ||
      !w.durations.length
    )
      return null;
    const sorted = [...w.durations].sort((a, b) => a - b);
    return {
      samples: sorted.length,
      failureRate: w.failures / sorted.length,
      p95ReadMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
    };
  }
  events(site: string, start: number, end: number) {
    return (this.incidents.get(site) ?? []).filter(
      (e) => Date.parse(e.at) >= start && Date.parse(e.at) < end,
    );
  }
}
const globalMonitor = globalThis as typeof globalThis & {
  usherTrialMonitor?: ProductionTrialMonitor;
};
function monitor() {
  return (globalMonitor.usherTrialMonitor ??= new ProductionTrialMonitor());
}
export function recordProductionRead(
  site: string,
  duration: number,
  ok: boolean,
  error?: unknown,
) {
  if (!process.env.USHER_TRIAL_MONITOR_TOKEN) return;
  const e = error as { status?: number; code?: string } | undefined;
  const incident =
    e?.status === 401
      ? "session-evicted"
      : e?.code === "ECONNRESET" || e?.code === "ECONNREFUSED"
        ? "connection-disruption"
        : undefined;
  monitor().record(site, Date.now(), duration, ok, incident);
}
export async function handleTrialExport(req: Request): Promise<Response> {
  const token = process.env.USHER_TRIAL_MONITOR_TOKEN;
  if (!token)
    return Response.json(
      { error: "trial evidence feed disabled" },
      { status: 503 },
    );
  const hash = (s: string) => createHash("sha256").update(s).digest();
  if (
    !timingSafeEqual(
      hash(req.headers.get("authorization") ?? ""),
      hash("Bearer " + token),
    )
  )
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const q = new URL(req.url).searchParams,
    site = q.get("siteId"),
    start = Date.parse(q.get("start") ?? ""),
    end = Date.parse(q.get("end") ?? "");
  if (
    !site ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 3600000 ||
    end > Date.now()
  )
    return Response.json({ error: "invalid evidence window" }, { status: 400 });
  const m = monitor();
  if (q.get("kind") === "window") {
    const metrics = m.window(site, end, Date.now());
    if (!metrics || end - start !== WINDOW)
      return Response.json(
        { error: "production window incomplete" },
        { status: 409 },
      );
    return Response.json(
      {
        role: "production",
        siteId: site,
        windowEnd: new Date(end).toISOString(),
        metrics,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (q.get("kind") === "incidents") {
    if (start < m.startedAt)
      return Response.json(
        { error: "production incident coverage incomplete" },
        { status: 409 },
      );
    return Response.json(
      {
        role: "production",
        siteId: site,
        incidents: m.events(site, start, end),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (q.get("kind") !== "fixtures")
    return Response.json({ error: "unknown export kind" }, { status: 400 });
  const dir = process.env.USHER_TRIAL_CAPTURE_DIR;
  if (!dir)
    return Response.json({ error: "capture disabled" }, { status: 503 });
  try {
    const files = (await readdir(dir))
      .filter((n) => !n.startsWith(".") && n.endsWith(".jsonl.gz"))
      .sort();
    const fixtures: unknown[] = [];
    let bytes = 0,
      last = q.get("cursor") ?? "",
      nextCursor = "";
    for (const name of files) {
      if (name <= (q.get("cursor") ?? "")) continue;
      const data = await unzip(await readFile(path.join(dir, name)), {
        maxOutputLength: 4 * 1024 * 1024,
      });
      const f = JSON.parse(data.toString());
      const at = Date.parse(f.at);
      if (f.pollerId !== site || at < start || at >= end) continue;
      if (fixtures.length >= 100 || bytes + data.length > 4 * 1024 * 1024) {
        nextCursor = last;
        if (!last) throw Error("oversized fixture");
        break;
      }
      fixtures.push(f);
      bytes += data.length;
      last = name;
    }
    return Response.json(
      { fixtures, nextCursor },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "capture export unavailable" },
      { status: 503 },
    );
  }
}
