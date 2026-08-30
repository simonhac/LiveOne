/**
 * The CLI side of the browser hand-off. The loopback listener is driven with real HTTP against
 * 127.0.0.1 — the port-0 bind and single-callback behaviour are the things worth proving, and a
 * mock would prove neither.
 */
import { describe, it, expect } from "@jest/globals";
import {
  newVerifier,
  newState,
  loginUrl,
  awaitCallback,
  challengeFor,
  stateMatches,
} from "../handoff";

describe("verifier / state / url", () => {
  it("mints distinct, url-safe values", () => {
    expect(newVerifier()).not.toBe(newVerifier());
    expect(newState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds the approval URL, with port only in browser mode", () => {
    const u = loginUrl("https://www.liveone.energy", {
      challenge: "c",
      state: "s",
      port: 49152,
      label: "my laptop",
    });
    const parsed = new URL(u);
    expect(parsed.pathname).toBe("/cli-auth");
    expect(parsed.searchParams.get("port")).toBe("49152");
    expect(parsed.searchParams.get("label")).toBe("my laptop");
    const noPort = new URL(
      loginUrl("https://x", { challenge: "c", state: "s", label: "l" }),
    );
    expect(noPort.searchParams.has("port")).toBe(false);
  });

  it("re-exports the SERVER'S challenge derivation, so the two sides cannot drift", () => {
    // If the CLI hashed differently from the server, every exchange would be challenge-mismatch.
    const v = newVerifier();
    expect(challengeFor(v)).toHaveLength(43); // base64url sha256, no padding
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("", "")).toBe(false);
  });
});

describe("awaitCallback — the loopback listener", () => {
  it("binds an ephemeral port, answers exactly one /callback, then closes", async () => {
    const listener = await awaitCallback(5_000);
    expect(listener.port).toBeGreaterThan(0);

    const res = await fetch(
      `http://127.0.0.1:${listener.port}/callback?code=abc.def&state=s123`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("close this tab");

    await expect(listener.result).resolves.toEqual({
      code: "abc.def",
      state: "s123",
    });

    // Closed after the first callback: the ephemeral server must not linger as a surface.
    await expect(
      fetch(`http://127.0.0.1:${listener.port}/callback?code=x&state=y`),
    ).rejects.toThrow();
  });

  it("404s anything that is not /callback", async () => {
    const listener = await awaitCallback(5_000);
    const res = await fetch(`http://127.0.0.1:${listener.port}/anything-else`);
    expect(res.status).toBe(404);
    listener.close();
  });

  it("rejects with an AUTH failure on timeout", async () => {
    const listener = await awaitCallback(50);
    await expect(listener.result).rejects.toMatchObject({
      detail: expect.objectContaining({ code: 3 }),
    });
  });
});
