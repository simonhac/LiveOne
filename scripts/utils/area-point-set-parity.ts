/**
 * The parity gate `docs/architecture/areas-and-dashboards.md` has always claimed and never had.
 *
 * > "Resolver changes are gated by parity assertions. Every change that touches point resolution
 * > asserts the per-area resolved point set is byte-identical pre/post."
 *
 * That gate was real and it did catch defects, but it was performed BY HAND three times and left no
 * artefact (`docs/plans/area-point-set-parity-harness.md`). This is the artefact: snapshot the
 * resolved point set of every addressable handle, then diff two snapshots.
 *
 *   npx tsx --env-file=.env.local scripts/utils/area-point-set-parity.ts snapshot before.json
 *   …make the resolver change…
 *   npx tsx --env-file=.env.local scripts/utils/area-point-set-parity.ts snapshot after.json
 *   npx tsx --env-file=.env.local scripts/utils/area-point-set-parity.ts diff before.json after.json
 *
 * It drives the REAL serving resolver (`PointManager._resolvePointsForHandle`, through the public
 * `getActivePointsForDevice`), so it exercises the device-first dispatch, the bindings override and
 * the membership union exactly as a request would — not a reimplementation of them.
 *
 * `diff` exits 1 when any handle's set changed, so it can gate CI or a deploy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { legacyHandles, areas, devices } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { PointManager } from "@/lib/point/point-manager";

interface Snapshot {
  takenAt: string;
  handles: Record<string, { label: string; points: string[] }>;
}

async function snapshot(path: string) {
  const db = requirePlanetscaleDb();
  const rows = await db
    .select({
      handle: legacyHandles.handle,
      areaId: legacyHandles.areaId,
      deviceId: legacyHandles.deviceId,
    })
    .from(legacyHandles)
    .orderBy(legacyHandles.handle);

  const pm = PointManager.getInstance();
  const out: Snapshot = { takenAt: new Date().toISOString(), handles: {} };

  for (const r of rows) {
    const [area] = r.areaId
      ? await db
          .select({ n: areas.name })
          .from(areas)
          .where(eq(areas.id, r.areaId))
          .limit(1)
      : [undefined];
    const [dev] = r.deviceId
      ? await db
          .select({ n: devices.name })
          .from(devices)
          .where(eq(devices.id, r.deviceId))
          .limit(1)
      : [undefined];
    const label = `${dev?.n ? `device:${dev.n}` : ""}${dev?.n && area?.n ? " + " : ""}${area?.n ? `area:${area.n}` : ""}`;

    let points: string[] = [];
    try {
      const resolved = await pm.getActivePointsForDevice(r.handle);
      // Sort so the comparison is set-equality, not incidental ordering. Order changes are a separate
      // question and are checked by `orderOf` below.
      points = resolved.map((p) => p.pointUid).sort();
    } catch (err) {
      points = [`<ERROR: ${(err as Error).message}>`];
    }
    out.handles[String(r.handle)] = { label, points };
  }

  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  const total = Object.values(out.handles).reduce(
    (n, h) => n + h.points.length,
    0,
  );
  console.log(
    `snapshot → ${path}: ${rows.length} handle(s), ${total} resolved point(s)`,
  );
}

function diff(aPath: string, bPath: string) {
  const a: Snapshot = JSON.parse(readFileSync(aPath, "utf8"));
  const b: Snapshot = JSON.parse(readFileSync(bPath, "utf8"));
  const keys = [
    ...new Set([...Object.keys(a.handles), ...Object.keys(b.handles)]),
  ].sort((x, y) => Number(x) - Number(y));

  let changed = 0;
  for (const k of keys) {
    const av = a.handles[k],
      bv = b.handles[k];
    if (!av) {
      console.log(`+ handle ${k} appeared (${bv.label})`);
      changed++;
      continue;
    }
    if (!bv) {
      console.log(`- handle ${k} vanished (${av.label})`);
      changed++;
      continue;
    }
    const as = new Set(av.points),
      bs = new Set(bv.points);
    const lost = av.points.filter((p) => !bs.has(p));
    const gained = bv.points.filter((p) => !as.has(p));
    if (lost.length === 0 && gained.length === 0) continue;
    changed++;
    console.log(`~ handle ${k}  ${av.label}`);
    console.log(`    ${av.points.length} → ${bv.points.length} point(s)`);
    if (lost.length) console.log(`    lost:   ${lost.join(", ")}`);
    if (gained.length) console.log(`    gained: ${gained.join(", ")}`);
  }

  console.log(
    changed === 0
      ? `\n✅ PARITY: all ${keys.length} handle(s) resolve to a byte-identical point set.`
      : `\n🛑 ${changed} of ${keys.length} handle(s) changed.`,
  );
  process.exit(changed === 0 ? 0 : 1);
}

const [cmd, p1, p2] = process.argv.slice(2);
if (cmd === "snapshot" && p1) snapshot(p1).then(() => process.exit(0));
else if (cmd === "diff" && p1 && p2) diff(p1, p2);
else {
  console.error(
    "usage: area-point-set-parity.ts snapshot <file> | diff <before> <after>",
  );
  process.exit(2);
}
