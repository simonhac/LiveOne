/**
 * Regression guard for the timezone leak: a placement EDIT on `systems` must reach the area-of-one.
 *
 * `ensureAreaOfOne`'s reconcile is `location`-only and fill-if-NULL (the area is the authority), and
 * `areas.timezone_offset_min` / `display_timezone` are NOT NULL and so never look missing — so before
 * `mirrorPlacementToAreaOfOne` every timezone edit was stranded on `systems`, which the terminal window
 * drops. `lib/registry/device-config.ts` reads tz from the area, so the edit reached nothing.
 *
 * ⚠️ This test cannot demonstrate the fix on its own — the bug was precisely that the write went
 * somewhere nothing reads, which a mock cannot tell you. It pins the two things a mock CAN pin: that
 * `dayOffsetMin` moves with `timezoneOffsetMin` (matching `updateAreaMeta`, the area's own writer), and
 * that an unnamed field is not written. The end-to-end proof is in the PR body.
 */
import { describe, expect, it } from "@jest/globals";
import { mirrorPlacementToAreaOfOne } from "../v4-mirror";

/** Records the `set` payloads an `update(areas)` would have issued. */
function fakeExec() {
  const sets: Record<string, unknown>[] = [];
  const exec: any = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          sets.push(values);
        },
      }),
    }),
  };
  return { exec, sets };
}

describe("mirrorPlacementToAreaOfOne", () => {
  it("writes displayTimezone through to the area", async () => {
    const { exec, sets } = fakeExec();
    await mirrorPlacementToAreaOfOne(
      5,
      { displayTimezone: "Australia/Perth" },
      exec,
    );
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ displayTimezone: "Australia/Perth" });
    // Not named in the patch → must not be written (this is intent propagation, not a blanket sync).
    expect(sets[0]).not.toHaveProperty("timezoneOffsetMin");
    expect(sets[0]).not.toHaveProperty("dayOffsetMin");
    expect(sets[0]).not.toHaveProperty("location");
  });

  it("moves dayOffsetMin with timezoneOffsetMin, like updateAreaMeta", async () => {
    const { exec, sets } = fakeExec();
    await mirrorPlacementToAreaOfOne(5, { timezoneOffsetMin: 480 }, exec);
    expect(sets[0]).toMatchObject({
      timezoneOffsetMin: 480,
      dayOffsetMin: 480,
    });
    expect(sets[0]).not.toHaveProperty("displayTimezone");
  });

  it("issues NO statement when the patch names no placement field", async () => {
    const { exec, sets } = fakeExec();
    await mirrorPlacementToAreaOfOne(5, {}, exec);
    expect(sets).toHaveLength(0);
  });
});
