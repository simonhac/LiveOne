/**
 * The hand-off authorization code and its PKCE binding.
 *
 * The code travels through a browser, so every case here is about what an observer of the code
 * alone can do — the answer must be "nothing".
 */
import { describe, it, expect } from "@jest/globals";
import {
  mintCode,
  verifyCode,
  challengeFor,
  stateMatches,
  CODE_TTL_SECONDS,
  CODE_SKEW_SECONDS,
} from "../code";

const SECRET = "test-signing-secret";
const NOW = new Date("2026-08-30T00:00:00Z");
const VERIFIER = "a-random-32-byte-verifier-value";
const at = (secondsFromNow: number) =>
  new Date(NOW.getTime() + secondsFromNow * 1000);

const mint = (over: Partial<{ u: string; c: string; l: string }> = {}) =>
  mintCode(
    { u: "user_abc", c: challengeFor(VERIFIER), l: "laptop", ...over },
    { secret: SECRET, now: NOW },
  );

describe("the happy path", () => {
  it("round-trips the payload when code and verifier agree", () => {
    const r = verifyCode(mint(), VERIFIER, { secret: SECRET, now: NOW });
    expect(r).toMatchObject({
      ok: true,
      payload: { u: "user_abc", l: "laptop" },
    });
  });
});

describe("the code alone is worthless — the PKCE binding", () => {
  it("refuses the right code with the WRONG verifier", () => {
    // The whole point: someone who sees the code (shell history, scrollback, a shoulder) but not
    // the verifier cannot exchange it.
    expect(
      verifyCode(mint(), "not-the-verifier", { secret: SECRET, now: NOW }),
    ).toEqual({
      ok: false,
      reason: "challenge-mismatch",
    });
  });

  it("refuses an empty verifier", () => {
    expect(verifyCode(mint(), "", { secret: SECRET, now: NOW }).ok).toBe(false);
  });

  it("cannot be satisfied by supplying the challenge instead of the verifier", () => {
    // A caller who saw the challenge (it goes in the URL) still needs its preimage.
    const challenge = challengeFor(VERIFIER);
    expect(verifyCode(mint(), challenge, { secret: SECRET, now: NOW }).ok).toBe(
      false,
    );
  });
});

describe("forgery", () => {
  it("refuses a code signed with a different secret", () => {
    const foreign = mintCode(
      { u: "user_attacker", c: challengeFor(VERIFIER), l: "l" },
      { secret: "some-other-secret", now: NOW },
    );
    expect(verifyCode(foreign, VERIFIER, { secret: SECRET, now: NOW })).toEqual(
      {
        ok: false,
        reason: "bad-signature",
      },
    );
  });

  it("refuses a tampered payload — including swapping in another user", () => {
    const code = mint();
    const [body, mac] = code.split(".");
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString());
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, u: "user_someone_else" }),
    ).toString("base64url");
    expect(
      verifyCode(`${forged}.${mac}`, VERIFIER, { secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses an unsigned or malformed code", () => {
    for (const bad of ["", "nodot", "a.b.c", ".sig", "body."])
      expect(verifyCode(bad, VERIFIER, { secret: SECRET, now: NOW }).ok).toBe(
        false,
      );
  });

  it("checks the signature BEFORE the expiry, so a forgery learns nothing about timing", () => {
    const stale = mintCode(
      { u: "u", c: challengeFor(VERIFIER), l: "l" },
      { secret: "wrong", now: NOW },
    );
    expect(
      verifyCode(stale, VERIFIER, { secret: SECRET, now: at(9999) }).ok,
    ).toBe(false);
    expect(
      verifyCode(stale, VERIFIER, { secret: SECRET, now: at(9999) }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("expiry", () => {
  it("accepts inside the window and refuses well outside it", () => {
    expect(
      verifyCode(mint(), VERIFIER, { secret: SECRET, now: at(60) }).ok,
    ).toBe(true);
    expect(
      verifyCode(mint(), VERIFIER, {
        secret: SECRET,
        now: at(CODE_TTL_SECONDS + CODE_SKEW_SECONDS + 5),
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("tolerates clock skew, but only just past the deadline", () => {
    const justPast = at(CODE_TTL_SECONDS + CODE_SKEW_SECONDS - 5);
    expect(
      verifyCode(mint(), VERIFIER, { secret: SECRET, now: justPast }).ok,
    ).toBe(true);
  });
});

describe("configuration", () => {
  it("refuses to mint or verify without a signing secret, rather than signing with nothing", () => {
    expect(() =>
      mintCode({ u: "u", c: "c", l: "l" }, { secret: "", now: NOW }),
    ).toThrow(/CLI_AUTH_SIGNING_SECRET/);
    expect(() =>
      verifyCode(mint(), VERIFIER, { secret: "", now: NOW }),
    ).toThrow(/CLI_AUTH_SIGNING_SECRET/);
  });
});

describe("stateMatches — the loopback CSRF defence", () => {
  it("matches only an exact, non-empty state", () => {
    expect(stateMatches("abc123", "abc123")).toBe(true);
    expect(stateMatches("abc123", "abc124")).toBe(false);
    expect(stateMatches("abc123", "abc")).toBe(false);
    // Empty must never match empty: a hostile callback that simply omits `state` would otherwise
    // satisfy a CLI that also failed to generate one.
    expect(stateMatches("", "")).toBe(false);
  });
});
