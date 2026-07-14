/**
 * Collector core — small filesystem helpers shared by the blackbox (journal) and spool (unsent
 * buffer). All best-effort and dependency-free: a broken disk must degrade the store, never the
 * collector loop.
 */

import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";

/** Ensure `dir` exists and is writable (probe file). Returns false instead of throwing. */
export async function ensureWritableDir(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/** Write atomically: temp file in the same dir, then rename (rename is atomic on one fs). */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export interface DiskSpace {
  capacityBytes: number;
  freeBytes: number;
  /** free as a fraction of capacity (0..1) */
  freeFrac: number;
}

/** Type of the injectable disk-space probe (tests stub this; prod uses statfs). */
export type DiskSpaceFn = (dir: string) => Promise<DiskSpace | null>;

/** Free/capacity of the filesystem holding `dir`, or null if statfs is unavailable. */
export async function diskSpace(dir: string): Promise<DiskSpace | null> {
  try {
    const s = await statfs(dir);
    const capacityBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    return {
      capacityBytes,
      freeBytes,
      freeFrac: capacityBytes > 0 ? freeBytes / capacityBytes : 0,
    };
  } catch {
    return null;
  }
}

/** gzip `src` → `src.gz`, then remove `src`. Throws on failure (caller logs + leaves src). */
export async function gzipFile(src: string): Promise<string> {
  const dest = `${src}.gz`;
  const tmp = `${dest}.tmp-${process.pid}`;
  await pipeline(
    createReadStream(src),
    zlib.createGzip(),
    createWriteStream(tmp),
  );
  await fs.rename(tmp, dest);
  await fs.unlink(src);
  return dest;
}

/** File names in `dir` matching `filter`, sorted ascending (names are time-prefixed → oldest first). */
export async function listSorted(
  dir: string,
  filter: (name: string) => boolean,
): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter(filter).sort();
  } catch {
    return [];
  }
}

/** Total bytes of the given file names inside `dir` (missing files count 0). */
export async function bytesOf(dir: string, names: string[]): Promise<number> {
  let total = 0;
  for (const n of names) {
    try {
      total += (await fs.stat(path.join(dir, n))).size;
    } catch {
      /* raced a delete — fine */
    }
  }
  return total;
}
