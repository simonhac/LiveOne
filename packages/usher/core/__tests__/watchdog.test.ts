/**
 * The watchdog restarts the process, so its false-positive behaviour matters more than its
 * true-positive behaviour: firing when a site is merely slow would take the OTHER site down too.
 * `exit` is injected — never the real process.exit.
 */

import { describe, it, expect } from "@jest/globals";
import { createWatchdog, stallThresholdMs } from "../watchdog";

function harness(opts: { startupGraceMs?: number } = {}) {
  let now = 1_000_000;
  const exits: number[] = [];
  const logs: string[] = [];
  const wd = createWatchdog({
    now: () => now,
    exit: (code) => exits.push(code),
    log: (m) => logs.push(m),
    startupGraceMs: opts.startupGraceMs ?? 120_000,
  });
  return { wd, exits, logs, advance: (ms: number) => (now += ms) };
}

describe("stallThresholdMs", () => {
  it("is 4 cadences, floored at 5 minutes", () => {
    expect(stallThresholdMs(15_000)).toBe(5 * 60_000); // musher: floor wins
    expect(stallThresholdMs(60_000)).toBe(5 * 60_000); // fusher: floor wins
    expect(stallThresholdMs(10 * 60_000)).toBe(40 * 60_000); // a slow source: 4x wins
  });
});

describe("watchdog", () => {
  it("stays quiet while ticks keep starting", () => {
    const { wd, exits, advance } = harness();
    wd.register("sheephouse", 15_000);
    advance(200_000); // past the startup grace
    for (let i = 0; i < 40; i++) {
      wd.noteTickStart("sheephouse");
      advance(15_000);
      wd.check();
    }
    expect(exits).toHaveLength(0);
  });

  it("exits once when a site stops starting ticks", () => {
    const { wd, exits, logs, advance } = harness();
    wd.register("sheephouse", 15_000);
    advance(200_000);
    wd.noteTickStart("sheephouse");

    advance(4 * 60_000); // inside the 5-min threshold
    wd.check();
    expect(exits).toHaveLength(0);

    advance(2 * 60_000); // now past it
    wd.check();
    expect(exits).toEqual([1]);
    expect(logs.join()).toMatch(/sheephouse.*wedged/);

    // Idempotent: a second sweep must not exit again (exit is a no-op under test, and in
    // production a double-exit would race the shutdown).
    advance(60 * 60_000);
    wd.check();
    expect(exits).toEqual([1]);
  });

  it("does not fire during the startup grace", () => {
    const { wd, exits, advance } = harness({ startupGraceMs: 120_000 });
    wd.register("sheephouse", 15_000);
    wd.noteTickStart("sheephouse");
    advance(60_000); // stale by the threshold, but still booting
    wd.check();
    expect(exits).toHaveLength(0);
  });

  // A source that never ticked at all is a construction/config problem, not a stall. Exiting would
  // crash-loop the machine forever and take the healthy site with it on every restart.
  it("does not fire for a source that has never ticked", () => {
    const { wd, exits, advance } = harness();
    wd.register("sheephouse", 15_000);
    advance(60 * 60_000);
    wd.check();
    expect(exits).toHaveLength(0);
  });

  it("watches each site independently", () => {
    const { wd, exits, logs, advance } = harness();
    wd.register("sheephouse", 15_000);
    wd.register("kinkora", 60_000);
    advance(200_000);
    wd.noteTickStart("sheephouse");
    wd.noteTickStart("kinkora");

    // kinkora keeps ticking; sheephouse wedges.
    for (let i = 0; i < 10; i++) {
      advance(60_000);
      wd.noteTickStart("kinkora");
    }
    wd.check();
    expect(exits).toEqual([1]);
    expect(logs.join()).toMatch(/sheephouse/);
  });
});
