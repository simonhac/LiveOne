import { describe, expect, it, jest } from "@jest/globals";
import { TrialCapture } from "../trial-capture";

describe("asynchronous trial input capture", () => {
  it("never waits for storage on the production collection path and bounds its queue", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const written: string[] = [];
    const capture = new TrialCapture(
      async (text) => {
        await blocked;
        written.push(text);
      },
      2,
      1024,
    );
    expect(
      capture.enqueue({ at: "first", raw: { value: 1, password: "secret" } }),
    ).toBe(true);
    expect(capture.enqueue({ at: "second" })).toBe(true);
    expect(capture.enqueue({ at: "third" })).toBe(false);
    expect(capture.dropped).toBe(1);
    expect(written).toHaveLength(0);
    release();
    await capture.flush();
    expect(written.map((v) => JSON.parse(v).at)).toEqual(["first", "second"]);
    expect(written.join("\n")).not.toContain("secret");
  });
  it("rejects oversized captures without growing the pending byte budget", async () => {
    const capture = new TrialCapture(async () => {}, 5, 100);
    expect(capture.enqueue({ raw: "x".repeat(101) })).toBe(false);
    expect(capture.dropped).toBe(1);
    await capture.flush();
  });
  it("accounts for failed writes without rejecting the production read", async () => {
    const capture = new TrialCapture(
      async () => {
        throw Error("disk unavailable");
      },
      5,
      1024,
    );
    expect(capture.enqueue({ raw: 1 })).toBe(true);
    await expect(capture.flush()).resolves.toBeUndefined();
    expect(capture.dropped).toBe(1);
  });
});

it("bounds compressed disk capture by size without expiring old records", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { randomBytes } = await import("node:crypto");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gousher-capture-"));
  try {
    const capture = TrialCapture.onDisk(dir, { bytes: 600, reserveBytes: 0 });
    capture.enqueue({ raw: randomBytes(128).toString("hex") });
    await capture.flush();
    let files = await fs.readdir(dir);
    expect(files).toHaveLength(1);
    const old = new Date("2000-01-01T00:00:00Z");
    await fs.utimes(path.join(dir, files[0]), old, old);
    const recovered = TrialCapture.onDisk(dir, { bytes: 600, reserveBytes: 0 });
    await recovered.flush();
    expect(await fs.readdir(dir)).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      capture.enqueue({ raw: randomBytes(128).toString("hex") });
      await capture.flush();
    }
    files = await fs.readdir(dir);
    const sizes = await Promise.all(
      files.map(async (f) => (await fs.stat(path.join(dir, f))).size),
    );
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("reclaims interrupted capture writes before adding more disk usage", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gousher-capture-recovery-"),
  );
  try {
    const abandoned = path.join(dir, ".pending-interrupted.jsonl.gz");
    await fs.writeFile(abandoned, Buffer.alloc(100));
    const capture = TrialCapture.onDisk(dir, { bytes: 600, reserveBytes: 0 });
    capture.enqueue({ value: 1 });
    await capture.flush();
    await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("preserves capture order when several records share the same wall-clock millisecond", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const crypto =
    jest.requireActual<typeof import("node:crypto")>("node:crypto");
  const zlib = await import("node:zlib");
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gousher-capture-order-"),
  );
  const clock = jest
    .spyOn(Date.prototype, "toISOString")
    .mockReturnValue("2026-09-12T00:00:00.000Z");
  let suffix = 3;
  const uuid = jest
    .spyOn(crypto, "randomUUID")
    .mockImplementation(
      () => `00000000-0000-4000-8000-${String(--suffix).padStart(12, "0")}`,
    );
  try {
    const capture = TrialCapture.onDisk(dir, { bytes: 4096, reserveBytes: 0 });
    for (let i = 0; i < 3; i++) {
      capture.enqueue({ sequence: i });
      await capture.flush();
    }
    const files = (await fs.readdir(dir)).sort();
    const records = await Promise.all(
      files.map(async (f) =>
        JSON.parse(
          zlib.gunzipSync(await fs.readFile(path.join(dir, f))).toString(),
        ),
      ),
    );
    expect(records.map((r) => r.sequence)).toEqual([0, 1, 2]);
  } finally {
    uuid.mockRestore();
    clock.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("scans retained captures once per writer and recovers the budget after restart", async () => {
  const fs =
    jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-inventory-"));
  const scan = jest.spyOn(fs, "readdir");
  const stat = jest.spyOn(fs, "stat");
  try {
    let capture = TrialCapture.onDisk(dir, { bytes: 200, reserveBytes: 0 });
    for (let i = 0; i < 20; i++) {
      capture.enqueue({ value: i });
      await capture.flush();
    }
    expect(capture.dropped).toBe(0);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalled();
    capture = TrialCapture.onDisk(dir, { bytes: 200, reserveBytes: 0 });
    capture.enqueue({ value: "after restart" });
    await capture.flush();
    expect(capture.dropped).toBe(0);
    expect(scan).toHaveBeenCalledTimes(2);
    const sizes = await Promise.all(
      (await fs.readdir(dir)).map(
        async (name) => (await fs.stat(path.join(dir, name))).size,
      ),
    );
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
  } finally {
    scan.mockRestore();
    stat.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("rebuilds its inventory after a failed commit and removes the pending file", async () => {
  const fs =
    jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-retry-"));
  const rename = jest.spyOn(fs, "rename");
  try {
    const capture = TrialCapture.onDisk(dir, { bytes: 200, reserveBytes: 0 });
    capture.enqueue({ value: 1 });
    await capture.flush();
    rename.mockRejectedValueOnce(new Error("disk error"));
    capture.enqueue({ value: 2 });
    await capture.flush();
    expect(capture.dropped).toBe(1);
    capture.enqueue({ value: 3 });
    await capture.flush();
    expect(capture.dropped).toBe(1);
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);
    expect(
      files.every(
        (name) => name.endsWith(".jsonl.gz") && !name.startsWith("."),
      ),
    ).toBe(true);
  } finally {
    rename.mockRestore();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
