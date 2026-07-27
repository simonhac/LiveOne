import { describe, it, expect, afterEach } from "@jest/globals";

/**
 * The cron kill-switch is what stops local dev and Vercel preview — which share the `liveone-dev`
 * database — from double-polling vendors and polluting the shared mirror, and it is prod's instant
 * stop button. The properties that matter are the default (unset ⇒ OFF, so a missing env var can
 * never silently enable a second poller) and the operator escape hatches.
 *
 * (This file previously covered the config-v4 cutover gate, removed in Phase 10 along with the
 * window it guarded.)
 */

import { cronsEnabled, cronSkipReason } from "../guard";

type Ctx = { isAdmin: boolean; isClaudeDev: boolean; isCron: boolean };
const ctx = (over: Partial<Ctx> = {}): any => ({
  isAdmin: false,
  isClaudeDev: false,
  isCron: true,
  userId: null,
  ...over,
});
const req = (force = false): any => ({
  nextUrl: { searchParams: new URLSearchParams(force ? "force=true" : "") },
});

const original = process.env.CRONS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.CRONS_ENABLED;
  else process.env.CRONS_ENABLED = original;
});

describe("cronsEnabled", () => {
  it('is true ONLY for the exact string "true"', () => {
    process.env.CRONS_ENABLED = "true";
    expect(cronsEnabled()).toBe(true);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ['"1" (truthy but not "true")', "1"],
    ['"TRUE" (wrong case)', "TRUE"],
    ['"yes"', "yes"],
    ['"false"', "false"],
  ])("is false when %s — unset must never mean enabled", (_label, value) => {
    if (value === undefined) delete process.env.CRONS_ENABLED;
    else process.env.CRONS_ENABLED = value;
    expect(cronsEnabled()).toBe(false);
  });
});

describe("cronSkipReason", () => {
  it("returns null (proceed) when crons are enabled", () => {
    process.env.CRONS_ENABLED = "true";
    expect(cronSkipReason(req(), ctx())).toBeNull();
  });

  it("skips a scheduled CRON_SECRET run when disabled, reporting the flag's value", () => {
    delete process.env.CRONS_ENABLED;
    const skip = cronSkipReason(req(), ctx());
    expect(skip).toMatchObject({ skipped: true });
    expect(skip!.reason).toContain("unset");
  });

  it.each([
    ["an admin session", ctx({ isAdmin: true }), req()],
    ["the dev x-claude header", ctx({ isClaudeDev: true }), req()],
    ["?force=true", ctx(), req(true)],
  ])("lets %s through as the operator escape hatch", (_label, c, r) => {
    delete process.env.CRONS_ENABLED;
    expect(cronSkipReason(r, c)).toBeNull();
  });

  it("does NOT treat a CRON_SECRET bearer call as an override — that is the run being suppressed", () => {
    delete process.env.CRONS_ENABLED;
    expect(cronSkipReason(req(), ctx({ isCron: true }))).toMatchObject({
      skipped: true,
    });
  });
});
