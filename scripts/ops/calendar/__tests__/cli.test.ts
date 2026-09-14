/**
 * `calendar --include-archived`, and the DEADLOCK it exists to break.
 *
 * 🛑 This is not symmetry-for-its-own-sake. Two interlocks meet here:
 *
 *   • `area delete` refuses while a LIVE calendar token references the area, so the token must be
 *     revoked first; and
 *   • `area delete` also refuses unless the area is already ARCHIVED.
 *
 * Every `calendar` verb resolves its area through the active-only listing, so archiving an area used
 * to make its tokens unreachable — you could no longer revoke the token that was stopping you
 * deleting the area you had just archived. Hit on prod with one shell area left to remove.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { calendarCommand } from "..";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };
const at = (argv: string[]) => parse(calendarCommand, argv, TTY, ["liveone"]);
const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};

describe("every calendar verb can reach an archived area", () => {
  it.each(["list", "mint", "revoke"] as const)(
    "`calendar %s` offers --include-archived",
    (verb) => {
      const spec = calendarCommand.subcommands?.[verb];
      expect(Object.keys(spec?.flags ?? {})).toContain("includeArchived");
    },
  );

  /**
   * The one that breaks the deadlock. If this stops parsing, an archived area's token becomes
   * unrevokable and the area therefore undeletable.
   */
  it("revoke accepts it alongside the token", () => {
    const r = success([
      "revoke",
      "ar_01kv06sxhnfx1rw3ba0qt10cx7",
      "abc123",
      "--include-archived",
      "--apply",
    ]);
    expect(r.flags.includeArchived).toBe(true);
    expect(r.dryRun).toBe(false);
  });

  it("defaults to off — an archived area stays hidden unless asked for", () => {
    expect(success(["list", "x"]).flags.includeArchived).toBe(false);
  });
});
