/**
 * The `session` verb's flag contract — `parse()` against the real spec, no network.
 *
 * Pinned: `list` gained a created_at window, `--failed`, csv and `--out` (the poll record of an
 * incident window), stays a READ (no write flags), and `create` stays dry-run by default.
 */
import { describe, expect, it } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { sessionCommand } from "../cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(sessionCommand, argv, TTY, ["liveone"]);
const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};
const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};

describe("session list", () => {
  it("takes a window, --failed, --cause, --out and csv", () => {
    const r = success([
      "list",
      "1",
      "--since=2026-09-17T09:19:00Z",
      "--until=2026-09-17T10:04:00Z",
      "--failed",
      "--cause=POLL",
      "--format=csv",
      "--out=s.csv",
    ]);
    expect(r.flags.since).toBe("2026-09-17T09:19:00Z");
    expect(r.flags.until).toBe("2026-09-17T10:04:00Z");
    expect(r.flags.failed).toBe(true);
    expect(r.flags.cause).toBe("POLL");
    expect(r.flags.out).toBe("s.csv");
    expect(r.format).toBe("csv");
  });

  it("leaves the window ABSENT when not passed — the newest-N list", () => {
    const r = success(["list", "1"]);
    expect(r.flags.since).toBeUndefined();
    expect(r.flags.until).toBeUndefined();
    expect(r.flags.failed).toBe(false);
  });

  it("is a read: no write flags", () => {
    expect(failure(["list", "1", "--apply"])).toMatch(/apply/i);
  });
});

describe("session create", () => {
  it("is dry-run by default", () => {
    const args = ["create", "1", "--label=x", "--manifest=m.json"];
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });
});
