/**
 * The pending-login record — the only piece of the hand-off that touches disk.
 *
 * Every test writes to a tmpdir. The real path is under `os.homedir()`, and a test that forgot to
 * pass `filePath` would clobber the developer's own half-finished login.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearPending,
  readPending,
  writePending,
  PENDING_TTL_MS,
  type PendingLogin,
} from "../pending-login";

let dir: string;
let file: string;

const RECORD: PendingLogin = {
  version: 1,
  origin: "https://www.liveone.energy",
  verifier: "v3r1f13r-not-a-real-one",
  state: "st4t3",
  label: "test-runner",
  createdAt: 1_700_000_000_000,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "liveone-pending-"));
  file = path.join(dir, "nested", "cli-auth-pending.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writePending", () => {
  it("creates the directory and writes the record 0600", () => {
    writePending(RECORD, file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readPending(file, RECORD.createdAt)).toEqual(RECORD);
  });

  it("replaces an earlier record rather than accumulating", () => {
    writePending(RECORD, file);
    const next = { ...RECORD, verifier: "second", label: "later" };
    writePending(next, file);
    expect(readPending(file, RECORD.createdAt)?.verifier).toBe("second");
  });

  it("leaves no temp file behind", () => {
    writePending(RECORD, file);
    const stray = fs
      .readdirSync(path.dirname(file))
      .filter((f) => f.includes(".tmp"));
    expect(stray).toEqual([]);
  });
});

describe("readPending", () => {
  it("returns null when there is no login in progress", () => {
    expect(readPending(file)).toBeNull();
  });

  it("refuses a record readable by others", () => {
    writePending(RECORD, file);
    fs.chmodSync(file, 0o644);
    // The verifier is what makes an observed code useless; a world-readable one is a broken binding.
    expect(() => readPending(file, RECORD.createdAt)).toThrow(
      /readable by others/,
    );
  });

  it("refuses a record that is not a v1 record", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2 }), { mode: 0o600 });
    expect(() => readPending(file, RECORD.createdAt)).toThrow(/v1 record/);
  });

  it("accepts a record inside the TTL", () => {
    writePending(RECORD, file);
    const stillFresh = RECORD.createdAt + PENDING_TTL_MS - 1;
    expect(readPending(file, stillFresh)?.verifier).toBe(RECORD.verifier);
  });

  it("refuses AND clears a stale record", () => {
    writePending(RECORD, file);
    const tooLate = RECORD.createdAt + PENDING_TTL_MS + 1;
    // CliFailure's message is the `why`, not the `what` — assert on the reason it gives.
    expect(() => readPending(file, tooLate)).toThrow(
      /more than 60 minutes ago/,
    );
    // Left in place, the same stale verifier would fail the NEXT --code the same way.
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("clearPending", () => {
  it("removes the record", () => {
    writePending(RECORD, file);
    clearPending(file);
    expect(readPending(file)).toBeNull();
  });

  it("is idempotent — the browser and paste paths call it having written nothing", () => {
    expect(() => clearPending(file)).not.toThrow();
    expect(() => clearPending(file)).not.toThrow();
  });
});
