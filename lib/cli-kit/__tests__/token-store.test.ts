/**
 * The per-origin credential store. The properties here are the multi-environment guarantees the
 * plan states outright: one origin's login never touches another's entry, resolution is strictly
 * by origin, and a store readable by others is refused rather than warned about.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeOrigin,
  readStore,
  setToken,
  removeToken,
  tokenFor,
  listEntries,
  type StoredToken,
} from "../token-store";
import { CliFailure } from "@/lib/cli/cli";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "liveone-store-"));
const at = (name: string) => path.join(tmp, name);

const entry = (label: string): StoredToken => ({
  token: `lo_cli_x.${label}`,
  tokenId: `cli_${label}`,
  userId: "user_abc",
  email: "simon@example.com",
  label,
  expiresAt: "2026-11-28T00:00:00.000Z",
});

afterEach(() => {
  delete process.env.LIVEONE_CLI_TOKEN;
});

describe("normalizeOrigin", () => {
  it("canonicalizes to the origin so keys never differ by path or slash", () => {
    expect(normalizeOrigin("https://www.liveone.energy/")).toBe(
      "https://www.liveone.energy",
    );
    expect(normalizeOrigin("http://localhost:3001/api/x")).toBe(
      "http://localhost:3001",
    );
  });

  it("refuses garbage with a usage-shaped failure", () => {
    expect(() => normalizeOrigin("not a url")).toThrow(CliFailure);
  });
});

describe("per-origin isolation", () => {
  it("login to one origin preserves every other entry byte-for-byte", () => {
    const f = at("iso.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    const before = JSON.parse(fs.readFileSync(f, "utf8")).tokens[
      "https://www.liveone.energy"
    ];
    setToken("http://localhost:3001", entry("dev"), f);
    const after = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(after.tokens["https://www.liveone.energy"]).toEqual(before);
    expect(Object.keys(after.tokens).sort()).toEqual([
      "http://localhost:3001",
      "https://www.liveone.energy",
    ]);
  });

  it("resolves strictly by origin — no silent borrow from another environment", () => {
    const f = at("borrow.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    expect(tokenFor("https://www.liveone.energy", f)?.label).toBe("prod");
    // The dangerous case: preview shares prod's Clerk instance, so a borrowed prod token WOULD
    // work there — which is exactly why absence must mean absence.
    expect(tokenFor("https://x.preview.liveone.energy", f)).toBeNull();
  });

  it("defaultOrigin follows the MOST RECENT login", () => {
    // First-login-wins was the original rule, and it meant a prod login after a localhost one left
    // every later command silently talking to localhost. Logging in says where you are working.
    const f = at("default.json");
    setToken("http://localhost:3001", entry("dev"), f);
    expect(readStore(f).defaultOrigin).toBe("http://localhost:3001");
    setToken("https://www.liveone.energy", entry("prod"), f);
    expect(readStore(f).defaultOrigin).toBe("https://www.liveone.energy");
  });
});

describe("removal", () => {
  it("forgets one origin, and adopts the one remaining login as the default", () => {
    const f = at("rm.json");
    setToken("http://localhost:3001", entry("dev"), f);
    setToken("https://www.liveone.energy", entry("prod"), f);
    // prod is the default (most recent login); logging out of it leaves exactly one login,
    // so that becomes the default rather than stranding the store with none.
    removeToken("https://www.liveone.energy", f);
    const s = readStore(f);
    expect(s.tokens["https://www.liveone.energy"]).toBeUndefined();
    expect(s.defaultOrigin).toBe("http://localhost:3001");
    removeToken("http://localhost:3001", f);
    expect(readStore(f).defaultOrigin).toBeUndefined();
  });

  it("clears the default rather than guessing, when several logins remain", () => {
    const f = at("rm-many.json");
    setToken("http://localhost:3001", entry("dev"), f);
    setToken("http://localhost:3002", entry("dev2"), f);
    setToken("https://www.liveone.energy", entry("prod"), f);
    removeToken("https://www.liveone.energy", f);
    expect(readStore(f).defaultOrigin).toBeUndefined();
  });

  it("leaves the default alone when a non-default origin is forgotten", () => {
    const f = at("rm-other.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    setToken("http://localhost:3001", entry("dev"), f);
    removeToken("https://www.liveone.energy", f);
    expect(readStore(f).defaultOrigin).toBe("http://localhost:3001");
  });
});

describe("hygiene", () => {
  it("a missing file reads as an empty store", () => {
    expect(readStore(at("nope.json"))).toEqual({ version: 1, tokens: {} });
  });

  it("REFUSES a store readable by group/other, naming the fix", () => {
    const f = at("loose.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    fs.chmodSync(f, 0o644);
    try {
      readStore(f);
      throw new Error("expected a refusal");
    } catch (err) {
      // The chmod hint rides in `next` (the actionable line), not the message.
      expect((err as CliFailure).detail).toMatchObject({
        code: 3,
        next: expect.stringContaining("chmod 600"),
      });
    }
  });

  it("writes 0600 and creates the directory 0700", () => {
    const f = path.join(tmp, "deep", "store.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
  });

  it("refuses a corrupt store rather than silently starting over", () => {
    const f = at("corrupt.json");
    fs.writeFileSync(f, "{not json", { mode: 0o600 });
    expect(() => readStore(f)).toThrow(/not readable as a v1 token store/);
  });

  it("never exposes the secret through listEntries", () => {
    const f = at("list.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    const listed = listEntries(f);
    expect(listed[0].origin).toBe("https://www.liveone.energy");
    expect(JSON.stringify(listed)).not.toContain("lo_cli_x.prod");
  });
});

describe("LIVEONE_CLI_TOKEN (CI)", () => {
  it("wins over the file, for any origin", () => {
    const f = at("env.json");
    setToken("https://www.liveone.energy", entry("prod"), f);
    process.env.LIVEONE_CLI_TOKEN = "lo_cli_from.env";
    expect(tokenFor("https://www.liveone.energy", f)?.token).toBe(
      "lo_cli_from.env",
    );
    expect(tokenFor("http://localhost:3001", f)?.token).toBe("lo_cli_from.env");
  });
});
