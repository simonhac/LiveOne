import { describe, it, expect, jest } from "@jest/globals";
import { parse, type Ctx, type Tty } from "@/lib/cli/cli";
import { deviceCommand } from "../cli";
import { windowParams } from "../coverage";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(deviceCommand, argv, TTY, ["liveone"]);
const ok = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r as unknown as Ctx;
};
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    const d = (e as { detail?: { what?: string } }).detail;
    if (d?.what) return d.what;
    throw e;
  }
  throw new Error("expected a refusal, but the call returned");
};

describe("the verb tree", () => {
  it("routes `device coverage`, and does not collide with `device config`", () => {
    expect(ok(["coverage", "kinkora"]).subcommandPath).toEqual(["coverage"]);
    expect(ok(["config", "lint"]).subcommandPath).toEqual(["config", "lint"]);
  });

  /** Read-only: `mutates` is not declared, so the parser itself must refuse `--apply`. */
  it("rejects --apply", () => {
    expect(at(["coverage", "kinkora", "--apply"]).ok).toBe(false);
  });

  it("takes --series repeatably", () => {
    expect(
      ok(["coverage", "k", "--series=a/*", "--series=b/*"]).flags.series,
    ).toEqual(["a/*", "b/*"]);
  });
});

describe("windowParams", () => {
  /**
   * 🛑 `last` is passed THROUGH to the server rather than resolved here. The window is whole local
   * days at the DEVICE's fixed day offset, which lives on the device — a client computing "the last
   * 90 days" would have to fetch the offset first and would be wrong for any device whose offset is
   * not the caller's.
   */
  it("passes --last through untouched", () => {
    expect(windowParams(ok(["coverage", "k", "--last=90d"]))).toBe("last=90d");
  });

  it("defaults to 30d — bounded, because the count is a range scan per point", () => {
    expect(windowParams(ok(["coverage", "k"]))).toBe("last=30d");
  });

  it("passes an explicit window as whole local days", () => {
    expect(
      windowParams(
        ok(["coverage", "k", "--start=2025-09-22", "--end=2026-09-15"]),
      ),
    ).toBe("start=2025-09-22&end=2026-09-15");
  });

  /** Coverage is counted per local day; a sub-daily window has no meaning to round into. */
  it("refuses a sub-daily --last rather than rounding it", () => {
    expect(
      refusal(() => windowParams(ok(["coverage", "k", "--last=3h"]))),
    ).toMatch(/not a whole number of days/);
  });

  it("refuses --last alongside an explicit window", () => {
    expect(
      refusal(() =>
        windowParams(
          ok([
            "coverage",
            "k",
            "--last=7d",
            "--start=2026-01-01",
            "--end=2026-01-07",
          ]),
        ),
      ),
    ).toMatch(/--last with --start/);
  });

  it("refuses half a window", () => {
    expect(
      refusal(() => windowParams(ok(["coverage", "k", "--start=2026-01-01"]))),
    ).toMatch(/--start without --end/);
  });

  it("refuses a window that runs backwards", () => {
    expect(
      refusal(() =>
        windowParams(
          ok(["coverage", "k", "--start=2026-02-01", "--end=2026-01-01"]),
        ),
      ),
    ).toMatch(/is before/);
  });
});
