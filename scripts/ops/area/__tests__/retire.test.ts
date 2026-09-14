/**
 * The `area archive` / `area delete` flag contract.
 *
 * These verbs are the only ones in the domain that can destroy a row, and the properties worth
 * pinning are the ones whose absence would be SILENT:
 *
 *   - dry-run by default (a `mutates` spec that forgets to branch on `ctx.dryRun` still parses);
 *   - no `--force` — an area's dependents are mostly unreproducible, so the refusal is the whole
 *     safety mechanism and a flag that waived it would look like a convenience;
 *   - no "absent means everything" — a variadic subject list with an empty case that sweeps the
 *     fleet is one mistyped shell expansion from deleting every area you own;
 *   - `--include-archived` reaches the verbs that need an archived area, and only those.
 *
 * `parse()` is importable without a network because the domain module has no entrypoint.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { areaCommand } from "../cli";
import { RETIRE_HANDLERS, subjects } from "../retire";
import type { Ctx } from "@/lib/cli/cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(areaCommand, argv, TTY, ["liveone"]);

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

describe("dispatch", () => {
  it.each([
    ["archive", "archive"],
    ["delete", "delete"],
  ])("`area %s` resolves to a handler", (_verb, key) => {
    expect(Object.keys(RETIRE_HANDLERS)).toContain(key);
  });

  // Both are single-segment, so the full-path key IS the last element — but the dispatcher looks up
  // the joined path, and a future `area delete something` would need the same discipline `purge`
  // learned. Pinning the current keys makes a nested verb an obvious, failing change.
  it("keys nothing by a path it cannot spell", () => {
    expect(Object.keys(RETIRE_HANDLERS).sort()).toEqual(["archive", "delete"]);
  });
});

describe("the write gate", () => {
  it.each([
    ["archive", ["archive", "kinkora-fronius"]],
    ["delete", ["delete", "kinkora-fronius"]],
  ])("%s is dry by default and offers --apply", (_n, args) => {
    expect(success(args).dryRun).toBe(true);
    expect(success([...args, "--apply"]).dryRun).toBe(false);
  });

  it.each([
    ["archive", ["archive", "kinkora-fronius"]],
    ["delete", ["delete", "kinkora-fronius"]],
  ])("%s --apply off a terminal refuses without --yes", (_n, args) => {
    const r = parse(
      areaCommand,
      [...args, "--apply"],
      { stdoutIsTTY: false, stdinIsTTY: false },
      ["liveone"],
    );
    expect(r.ok).toBe(false);
  });

  it("--apply --dry-run is contradictory", () => {
    expect(failure(["delete", "x", "--apply", "--dry-run"])).toMatch(/apply/);
  });
});

describe("no subject means no action", () => {
  /**
   * 🛑 `parse()` does NOT cover this, which is exactly why it is tested here. `required: true` on a
   * VARIADIC arg is satisfied by an empty list, so `liveone area delete` with no argument parses
   * cleanly and reaches the handler — the runtime `subjects()` guard is the only thing between that
   * and a verb whose empty case could be read as "all of them".
   */
  it("parses cleanly with no argument — the parser is not the guard", () => {
    expect(success(["delete"]).args).toEqual([]);
  });

  it("subjects() refuses an empty list", () => {
    expect(() => subjects({ args: [] } as unknown as Ctx)).toThrow(
      /absent means everything/,
    );
  });

  it("subjects() refuses a list of empty strings", () => {
    expect(() => subjects({ args: ["", ""] } as unknown as Ctx)).toThrow(
      /absent means everything/,
    );
  });

  it("takes more than one area", () => {
    expect(subjects({ args: ["a", "b", "c"] } as unknown as Ctx)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("🛑 delete has no force, and must never grow one", () => {
  it("rejects --force", () => {
    // If this ever starts passing, the refusal has become waivable — which for an area means a
    // calendar credential that cannot be re-minted at the same URL, and Sankey days nothing heals.
    expect(failure(["delete", "kinkora-fronius", "--force"])).toMatch(/force/);
  });

  it("does not declare a force flag on either verb", () => {
    for (const verb of ["archive", "delete"] as const) {
      const spec = areaCommand.subcommands?.[verb];
      expect(Object.keys(spec?.flags ?? {})).not.toContain("force");
    }
  });
});

describe("--include-archived", () => {
  it("is accepted by delete, which can only ever act on an archived area", () => {
    expect(
      success(["delete", "kuti-house", "--include-archived"]).flags
        .includeArchived,
    ).toBe(true);
  });

  it.each([
    ["list", ["list"]],
    ["show", ["show", "kuti-house"]],
    [
      "purge flows",
      [
        "purge",
        "flows",
        "kuti-house",
        "--start=2026-07-06",
        "--end=2026-08-02",
      ],
    ],
    ["purge provenance", ["purge", "provenance", "kuti-house"]],
    ["provenance", ["provenance", "kuti-house"]],
  ])("reaches `area %s`", (_n, args) => {
    expect(success([...args, "--include-archived"]).flags.includeArchived).toBe(
      true,
    );
  });

  it("defaults to off everywhere — an archived area is hidden unless asked for", () => {
    expect(success(["list"]).flags.includeArchived).toBe(false);
    expect(success(["delete", "x"]).flags.includeArchived).toBe(false);
  });

  /**
   * 🛑 `archive` deliberately does NOT carry it. Archiving an already-archived area is a no-op, and
   * the un-archive path (`--undo`) resolves with the flag implied — offering it here would suggest
   * you could archive something you cannot see.
   */
  it("is not offered on archive, which has --undo instead", () => {
    expect(failure(["archive", "x", "--include-archived"])).toMatch(
      /include-archived/,
    );
    expect(success(["archive", "x", "--undo"]).flags.undo).toBe(true);
  });
});

/**
 * 🛑 HANDLER-level, not parse-level. Review pointed out that every assertion above still passes if
 * the handlers write unconditionally — `mutates: true` DECLARES the gate, and honouring it is a
 * separate act that the kit's own docs warn has been got wrong before ("two tools gated only the
 * confirmation prompt, so a dry run listed what it would do and then did it").
 *
 * So these drive `runArchive`/`runDelete` with a fake session and assert on the HTTP verbs actually
 * issued. `withApiSession` and `apiFetch` are the only two seams that reach the network.
 */
describe("the handlers honour the gate they declare", () => {
  const calls: { method: string; path: string }[] = [];
  let deps: unknown[] = [];

  beforeEach(() => {
    calls.length = 0;
    deps = [];
    jest.resetModules();
  });

  /** Runs a verb with the network stubbed; returns every request it made. */
  async function run(argv: string[]) {
    jest.doMock("@/lib/cli-kit/api-session", () => ({
      withApiSession: async (_ctx: unknown, fn: (s: unknown) => unknown) =>
        fn({
          origin: "https://example.test",
          token: "lo_cli_x",
          get: async (path: string) => {
            calls.push({ method: "GET", path });
            if (path.startsWith("/api/v4/areas?") || path === "/api/v4/areas")
              return {
                areas: [
                  {
                    id: "ar_x",
                    displayName: "Shell",
                    legacySystemId: 1,
                    status: "archived",
                  },
                ],
              };
            if (path.includes("/dependents")) return { dependents: deps };
            return {};
          },
        }),
    }));
    jest.doMock("@/lib/cli-kit/http", () => ({
      apiFetch: async (_o: string, path: string, init: { method: string }) => {
        calls.push({ method: init.method, path });
        return { body: { deleted: { id: "ar_x", name: "Shell", handle: 1 } } };
      },
    }));
    const { RETIRE_HANDLERS } = await import("../retire");
    const parsed = at(argv);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.what}`);
    // `parse()` yields the decoded flags/args; the rest of `Ctx` is the output surface, which these
    // tests only need to not explode on. The RENDERING is asserted elsewhere; what is asserted here
    // is which HTTP verbs were issued.
    const ctx = {
      ...parsed,
      emit: () => {},
      note: () => {},
      warn: () => {},
      confirm: async () => true,
    };
    const verb = argv[0];
    await RETIRE_HANDLERS[verb](ctx as never);
    return calls;
  }

  const writes = () => calls.filter((c) => c.method !== "GET");

  it.each([
    ["archive", ["archive", "shell"]],
    ["delete", ["delete", "shell", "--include-archived"]],
  ])("%s issues NO write verb in a dry run", async (_n, argv) => {
    await run(argv);
    expect(writes()).toEqual([]);
  });

  it("archive PATCHes only with --apply", async () => {
    await run(["archive", "shell", "--apply", "--yes"]);
    expect(writes().map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("delete DELETEs only with --apply", async () => {
    await run(["delete", "shell", "--include-archived", "--apply", "--yes"]);
    expect(writes().map((c) => c.method)).toEqual(["DELETE"]);
  });

  /** The dry run must ASK, not assume — this is the preview fidelity fix. */
  it("delete asks for the DESTRUCTIVE dependent list before promising anything", async () => {
    await run(["delete", "shell", "--include-archived"]);
    expect(
      calls.some(
        (c) =>
          c.method === "GET" && c.path.includes("/dependents?destructive=true"),
      ),
    ).toBe(true);
  });

  it("archive asks for the ARCHIVE dependent list, not the destructive one", async () => {
    await run(["archive", "shell"]);
    const dep = calls.find((c) => c.path.includes("/dependents"));
    expect(dep).toBeDefined();
    expect(dep!.path).not.toContain("destructive=true");
  });

  /** 🛑 Knowing it will be refused, --apply must not fire the write anyway. */
  it("delete does not attempt the write when the preview found a blocker", async () => {
    deps = [
      {
        kind: "calendar-feed",
        id: "…abc",
        name: "simon",
        via: "area_calendar_tokens.area_id",
        effect: "cascade-deleted",
        fix: "revoke it first",
      },
    ];
    await run(["delete", "shell", "--include-archived", "--apply", "--yes"]);
    expect(writes()).toEqual([]);
  });
});
