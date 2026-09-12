import * as fs from "node:fs/promises";
import path from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const compress = promisify(gzip);
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/password|token|secret|cookie|authorization|api.?key|^pwd$/i.test(
              key,
            ),
        )
        .map(([key, v]) => [key, redact(v)]),
    );
  return value;
}

/** Optional flight recording. enqueue is synchronous and never awaits storage. */
export class TrialCapture {
  dropped = 0;
  private count = 0;
  private bytes = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly write: (text: string) => Promise<void>,
    private readonly maxQueued = 64,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {}
  enqueue(record: unknown): boolean {
    let text: string;
    try {
      text = JSON.stringify(redact(record));
    } catch {
      this.dropped++;
      return false;
    }
    const size = Buffer.byteLength(text);
    if (this.count >= this.maxQueued || size + this.bytes > this.maxBytes) {
      this.dropped++;
      return false;
    }
    this.count++;
    this.bytes += size;
    this.chain = this.chain
      .then(() => this.write(text))
      .catch(() => {
        this.dropped++;
      })
      .finally(() => {
        this.count--;
        this.bytes -= size;
      });
    return true;
  }
  async flush(): Promise<void> {
    await this.chain;
  }
  static onDisk(
    dir: string,
    budget = { bytes: 32 * 1024 * 1024, reserveBytes: 64 * 1024 * 1024 },
  ): TrialCapture {
    let sequence = 0;
    return new TrialCapture(async (text) => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const data = await compress(text + "\n");
      if (data.length > budget.bytes) throw Error("Capture exceeds budget");
      const entries = await fs.readdir(dir);
      for (const name of entries.filter((f) => f.startsWith(".pending-")))
        await fs.unlink(path.join(dir, name));
      const files = await Promise.all(
        entries
          .filter((f) => !f.startsWith(".") && f.endsWith(".jsonl.gz"))
          .map(async (name) => ({
            name,
            ...(await fs.stat(path.join(dir, name))),
          })),
      );
      files.sort(
        (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name),
      );
      let bytes = files.reduce((sum, f) => sum + f.size, 0);
      let disk = await fs.statfs(dir);
      let free = Number(disk.bavail) * Number(disk.bsize);
      while (
        files.length &&
        (bytes + data.length > budget.bytes ||
          free - data.length < budget.reserveBytes)
      ) {
        const oldest = files.shift()!;
        await fs.unlink(path.join(dir, oldest.name));
        bytes -= oldest.size;
        disk = await fs.statfs(dir);
        free = Number(disk.bavail) * Number(disk.bsize);
      }
      if (free - data.length < budget.reserveBytes)
        throw Error("Capture free-space reserve reached");
      const name = `${new Date().toISOString().replace(/:/g, "-")}-${String(sequence++).padStart(12, "0")}-${randomUUID()}.jsonl.gz`;
      const temp = path.join(dir, `.pending-${name}`);
      const final = path.join(dir, name);
      const file = await fs.open(temp, "wx", 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await fs.rename(temp, final);
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    });
  }
}

let configuredDir: string | undefined;
let recorder: TrialCapture | undefined;
/** Disabled unless both the capture directory and reviewed configuration revision are explicit. */
export function captureTrial(record: Record<string, unknown>): void {
  const dir = process.env.USHER_TRIAL_CAPTURE_DIR;
  const revision = Number(process.env.USHER_TRIAL_CAPTURE_REVISION);
  if (!dir || !Number.isSafeInteger(revision) || revision < 1) return;
  if (!recorder || configuredDir !== dir) {
    configuredDir = dir;
    recorder = TrialCapture.onDisk(dir);
  }
  const before = recorder.dropped;
  recorder.enqueue({ ...record, revision });
  if (recorder.dropped !== before)
    console.warn(
      `[trial-capture] dropped=${recorder.dropped}; capture budget exhausted`,
    );
}
