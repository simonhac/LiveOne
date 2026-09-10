/**
 * The `queue` domain's flag contract and its write resolution.
 *
 * `parse()` and `resolveWrite()` are importable here because the domain module has no entrypoint
 * (`scripts/ops/derivation` and `scripts/ops/find` do the same), so both can be exercised without a
 * network, a token, or a running server.
 *
 * What is worth pinning here is the refusals. `resolveWrite` is reached mid-incident, on the levers,
 * where a confusing refusal costs minutes — the server enforces the same rules, so the value here
 * is a sentence that names the lever instead of a bare 422.
 */
import { describe, it, expect } from "@jest/globals";
import { parse, type Tty } from "@/lib/cli/cli";
import { queueCommand, resolveWrite, render, type WireQueue } from "../cli";

const TTY: Tty = { stdoutIsTTY: true, stdinIsTTY: true };

const at = (argv: string[]) => parse(queueCommand, argv, TTY, ["liveone"]);

const failure = (argv: string[]) => {
  const r = at(argv);
  if (r.ok) throw new Error("expected a usage error, got ok");
  return JSON.stringify(r.error);
};

const success = (argv: string[]) => {
  const r = at(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error.what}`);
  return r;
};

const refusal = (r: ReturnType<typeof resolveWrite>) => {
  if (r.ok) throw new Error("expected a refusal, got a body");
  return `${r.what} ${r.why} ${r.next}`;
};

const body = (r: ReturnType<typeof resolveWrite>) => {
  if (!r.ok) throw new Error(`expected a body, got refusal: ${r.what}`);
  return r.body;
};

describe("the flag contract", () => {
  it.each(["status", "pause", "resume", "parallelism"])(
    "%s accepts --lane on both lanes and all",
    (verb) => {
      for (const lane of ["live", "backfill", "all"])
        expect(success([verb, `--lane=${lane}`]).flags.lane).toBe(lane);
    },
  );

  it.each(["status", "pause", "resume", "parallelism"])(
    "%s refuses a lane that does not exist",
    (verb) => {
      // The enum catches a typo here rather than letting it round-trip to a 422 from prod.
      expect(failure([verb, "--lane=backfil"])).toMatch(/lane/i);
    },
  );

  it("keeps the write gate on the three mutating verbs", () => {
    for (const argv of [["pause"], ["resume"], ["parallelism", "5"]]) {
      expect(success(argv).dryRun).toBe(true);
      expect(success([...argv, "--apply"]).dryRun).toBe(false);
    }
  });

  it("gives status no write flags at all", () => {
    expect(failure(["status", "--apply"])).toMatch(/apply/i);
  });
});

describe("resolveWrite", () => {
  it("defaults pause/resume to every lane", () => {
    expect(body(resolveWrite({ paused: true }))).toEqual({
      lane: "all",
      paused: true,
    });
  });

  it("scopes a pause to one lane", () => {
    expect(body(resolveWrite({ lane: "backfill", paused: true }))).toEqual({
      lane: "backfill",
      paused: true,
    });
  });

  it("requires a lane to set parallelism", () => {
    // The pool ceiling is on the SUM across lanes, so one number applied to every lane at once is
    // the accident worth refusing. The server enforces it; this names the lever.
    const r = resolveWrite({ parallelism: 5 });
    expect(refusal(r)).toMatch(/--lane/);
    expect(refusal(r)).toMatch(/--lane=live/);
  });

  it("refuses --lane=all for parallelism specifically", () => {
    expect(refusal(resolveWrite({ lane: "all", parallelism: 5 }))).toMatch(
      /all/,
    );
  });

  it("carries a lane-scoped pin and unpin", () => {
    expect(body(resolveWrite({ lane: "live", parallelism: 5 }))).toEqual({
      lane: "live",
      parallelism: 5,
    });
    expect(body(resolveWrite({ lane: "backfill", parallelism: null }))).toEqual(
      { lane: "backfill", parallelism: null },
    );
  });
});

describe("render", () => {
  const base: WireQueue = {
    name: "observations",
    globalParallelism: { max: 0, inFlight: 0 },
    waiting: 0,
    inFlight: 0,
    pausedLanes: [],
    lanes: [
      {
        lane: "live",
        key: "obs:live",
        waiting: 0,
        inFlight: 0,
        parallelism: 5,
        pinned: false,
        paused: false,
        idle: false,
        stuck: false,
      },
      {
        lane: "backfill",
        key: "obs:backfill",
        waiting: 0,
        inFlight: 0,
        parallelism: 2,
        pinned: false,
        paused: false,
        idle: false,
        stuck: false,
      },
    ],
    lastIngestedAt: "2026-09-09T23:00:00.000Z",
    stalledMinutes: 0.2,
    stalled: false,
    paused: false,
  };

  const laneRow = (out: string, lane: string) =>
    out.split("\n").find((l) => l.startsWith(lane)) ?? "";

  it("reports waiting AND in flight per lane", () => {
    // The plan's verification item: `waitListSize` alone was misread as a throughput deficit twice.
    // Both numbers on one row is what makes the diagnosis unambiguous.
    const out = render({
      ...base,
      lanes: [
        { ...base.lanes![0], waiting: 1053, inFlight: 5 },
        base.lanes![1],
      ],
    });
    expect(out).toMatch(/waiting/);
    expect(out).toMatch(/in flight/);
    expect(laneRow(out, "live")).toMatch(/1053\s+5/);
  });

  it("never renders an unreadable lane as idle", () => {
    // 🛑 "I could not read this lane" and "this lane is quiet" both produce zeros. Collapsing them
    // would surface the failure as the reassuring one.
    const out = render({
      ...base,
      lanes: [
        { ...base.lanes![0], idle: true, error: "502 from QStash" },
        base.lanes![1],
      ],
    });
    expect(laneRow(out, "live")).toMatch(/UNREADABLE/);
    expect(laneRow(out, "live")).not.toMatch(/idle/);
  });

  it("ranks STUCK above PAUSED and idle", () => {
    const out = render({
      ...base,
      lanes: [{ ...base.lanes![0], stuck: true, paused: true }, base.lanes![1]],
    });
    expect(laneRow(out, "live")).toMatch(/STUCK/);
  });

  it("marks a pinned cap and explains the mark", () => {
    const out = render({
      ...base,
      lanes: [{ ...base.lanes![0], pinned: true }, base.lanes![1]],
    });
    expect(laneRow(out, "live")).toMatch(/5\*/);
    expect(out).toMatch(/pinned/);
  });

  it("degrades to the one-line read against an origin that predates the lanes", () => {
    // A rollback, or a preview on an older build. The lane table would otherwise render empty and
    // read as "no lanes exist", which is what a total stop looks like.
    const { lanes: _lanes, ...old } = base;
    const out = render({ ...old, waiting: 12 } as WireQueue);
    expect(out).toMatch(/predates the flow-control split/);
    expect(out).toMatch(/waiting\s+12/);
  });
});
