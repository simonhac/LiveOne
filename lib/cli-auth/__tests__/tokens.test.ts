/**
 * The pure half of CLI-token authentication.
 *
 * Everything here is a security property, so each case states the attack or mistake it forecloses
 * rather than just the behaviour.
 */
import { describe, it, expect } from "@jest/globals";
import {
  mintToken,
  verifyToken,
  parseToken,
  revokeToken,
  describeTokens,
  recordsOf,
  shouldTouch,
  isLive,
  MAX_LIVE_TOKENS,
  MAX_TTL_DAYS,
  TOKEN_PREFIX,
  METADATA_KEY,
  type UserLike,
} from "../tokens";

const NOW = new Date("2026-08-30T00:00:00Z");
const LATER = new Date("2026-12-30T00:00:00Z"); // > 90 days on

const userWith = (records: unknown[], id = "user_abc123"): UserLike => ({
  id,
  privateMetadata: { [METADATA_KEY]: records },
});

function mintFor(user: UserLike, label = "laptop") {
  return mintToken(user, { label, now: NOW });
}

describe("mintToken", () => {
  it("returns a token the user can verify, and stores only its hash", () => {
    const user = userWith([]);
    const { token, record, records } = mintFor(user);
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    // The secret must not be recoverable from what is persisted.
    expect(JSON.stringify(records)).not.toContain(token.split(".").pop());
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyToken(token, userWith(records), NOW).ok).toBe(true);
  });

  it("embeds the user id so the record can be found, since Clerk cannot query metadata", () => {
    const { token } = mintFor(userWith([], "user_xyz"));
    expect(parseToken(token)!.userId).toBe("user_xyz");
  });

  it("mints a distinct secret every time", () => {
    const user = userWith([]);
    const a = mintFor(user).token;
    const b = mintFor(user).token;
    expect(a).not.toBe(b);
  });

  it("prunes lapsed tokens rather than counting them against the cap", () => {
    const expired = Array.from({ length: MAX_LIVE_TOKENS }, (_, i) => ({
      id: `cli_${i}`,
      hash: "00",
      label: "old",
      scopes: ["*"],
      createdAt: NOW.toISOString(),
      expiresAt: NOW.toISOString(), // already lapsed
    }));
    const { records } = mintToken(userWith(expired), {
      label: "new",
      now: LATER,
    });
    expect(records).toHaveLength(1);
  });

  it("refuses to mint past the live cap", () => {
    const live = Array.from({ length: MAX_LIVE_TOKENS }, (_, i) => ({
      id: `cli_${i}`,
      hash: "00",
      label: "l",
      scopes: ["*"],
      createdAt: NOW.toISOString(),
      expiresAt: LATER.toISOString(),
    }));
    expect(() => mintFor(userWith(live))).toThrow(/max 10/);
  });

  it("refuses a nonsensical or unbounded ttl", () => {
    for (const ttlDays of [0, -1, 1.5, MAX_TTL_DAYS + 1])
      expect(() =>
        mintToken(userWith([]), { label: "l", ttlDays, now: NOW }),
      ).toThrow(/ttlDays/);
  });
});

describe("parseToken", () => {
  it("rejects anything that is not a well-formed CLI token", () => {
    for (const bad of [
      "",
      "lo_cli_",
      "lo_cli_abc", // no secret separator
      "lo_cli_.secret", // no user
      "lo_cli_dXNlcl9hYmNk.", // no secret
      "lo_cli_dXNlcl9hYmNk.a.b", // more than one separator — ambiguous, so refused
      "Bearer lo_cli_x_y", // scheme left on
      "gk_something", // a different app credential
      "eyJhbGciOi.x.y", // a Clerk JWT
    ])
      expect(parseToken(bad)).toBeNull();
  });

  it("rejects a decoded user id that is not id-shaped", () => {
    const encoded = Buffer.from("!!not an id!!", "utf8").toString("base64url");
    expect(parseToken(`${TOKEN_PREFIX}${encoded}.secret`)).toBeNull();
  });

  it("uses a separator that cannot occur in either half", () => {
    // Both halves are base64url ([A-Za-z0-9-_]), so a `.` split is unambiguous by construction
    // rather than by luck about Clerk's id charset.
    const { token } = mintToken(
      { id: "user_abcdef" },
      { label: "l", now: NOW },
    );
    const body = token.slice(TOKEN_PREFIX.length);
    expect(body.split(".")).toHaveLength(2);
    expect(parseToken(token)!.userId).toBe("user_abcdef");
  });
});

describe("verifyToken", () => {
  const user = userWith([]);
  const { token, records } = mintFor(user);
  const holder = userWith(records);

  it("accepts the real thing", () => {
    expect(verifyToken(token, holder, NOW)).toMatchObject({ ok: true });
  });

  it("rejects a token minted for a DIFFERENT user, even against a valid record", () => {
    // Splicing another user's id onto a good secret must not authenticate as them.
    const other = userWith(records, "user_someone_else");
    expect(verifyToken(token, other, NOW)).toEqual({
      ok: false,
      reason: "wrong-user",
    });
  });

  it("rejects a tampered secret", () => {
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyToken(tampered, holder, NOW).ok).toBe(false);
  });

  it("rejects a user holding no records at all", () => {
    expect(verifyToken(token, { id: user.id }, NOW)).toEqual({
      ok: false,
      reason: "unknown-secret",
    });
  });

  it("rejects an expired token", () => {
    expect(verifyToken(token, holder, LATER)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a revoked token even before it expires", () => {
    const { records: revoked } = revokeToken(holder, {
      all: true,
      now: NOW,
    });
    expect(verifyToken(token, userWith(revoked), NOW)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("treats a record with an unparseable expiry as DEAD, agreeing with isLive", () => {
    // NaN comparisons are all false, so the two liveness checks must be written the same way round
    // or they disagree — and the disagreement would be fail-OPEN in the verifier.
    const { token: t, records: r } = mintFor(userWith([]));
    const broken = [{ ...r[0], expiresAt: "not-a-date" }];
    expect(isLive(broken[0], NOW)).toBe(false);
    expect(verifyToken(t, userWith(broken), NOW)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("survives a malformed stored hash without throwing", () => {
    const junk = userWith([
      {
        id: "x",
        hash: "not-hex!!",
        label: "l",
        scopes: ["*"],
        createdAt: "",
        expiresAt: LATER.toISOString(),
      },
    ]);
    expect(verifyToken(token, junk, NOW).ok).toBe(false);
  });

  it("tolerates metadata that is absent or the wrong shape", () => {
    expect(recordsOf({ id: "u" })).toEqual([]);
    expect(
      recordsOf({ id: "u", privateMetadata: { cliTokens: "nope" } }),
    ).toEqual([]);
  });
});

describe("revokeToken", () => {
  it("revokes one by id, leaving the others alone", () => {
    const u = userWith([]);
    const a = mintFor(u, "a");
    const b = mintToken(userWith(a.records), { label: "b", now: NOW });
    const { records, revoked } = revokeToken(userWith(b.records), {
      id: a.record.id,
      now: NOW,
    });
    expect(revoked).toBe(1);
    expect(verifyToken(a.token, userWith(records), NOW).ok).toBe(false);
    expect(verifyToken(b.token, userWith(records), NOW).ok).toBe(true);
  });

  it("is idempotent — re-revoking counts nothing", () => {
    const { records } = mintFor(userWith([]));
    const once = revokeToken(userWith(records), { all: true, now: NOW });
    const twice = revokeToken(userWith(once.records), { all: true, now: NOW });
    expect(twice.revoked).toBe(0);
  });
});

describe("describeTokens", () => {
  it("never exposes the hash", () => {
    const { records } = mintFor(userWith([]));
    const described = describeTokens(userWith(records), NOW);
    expect(described[0]).not.toHaveProperty("hash");
    expect(described[0].live).toBe(true);
    expect(JSON.stringify(described)).not.toContain(records[0].hash);
  });
});

describe("shouldTouch / isLive", () => {
  it("throttles lastUsedAt to once an hour, so a Clerk write is not on every request", () => {
    const base = {
      id: "x",
      hash: "00",
      label: "l",
      scopes: ["*"],
      createdAt: NOW.toISOString(),
      expiresAt: LATER.toISOString(),
    };
    expect(shouldTouch(base, NOW)).toBe(true);
    expect(
      shouldTouch(
        { ...base, lastUsedAt: NOW.toISOString() },
        new Date(NOW.getTime() + 60_000),
      ),
    ).toBe(false);
    expect(
      shouldTouch(
        { ...base, lastUsedAt: NOW.toISOString() },
        new Date(NOW.getTime() + 7_200_000),
      ),
    ).toBe(true);
    expect(isLive(base, NOW)).toBe(true);
    expect(isLive({ ...base, revokedAt: NOW.toISOString() }, NOW)).toBe(false);
  });
});
