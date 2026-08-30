/**
 * Which server a command is about to talk to. One resolver, because two would let `auth login`
 * store a token for one host while `dashboard set-prop --apply` writes to another.
 */
import { describe, it, expect, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ORIGIN, resolveOrigin, requireToken } from "../target";
import { setToken } from "../token-store";
import { CliFailure, type Ctx } from "@/lib/cli/cli";

const ctx = (flags: Record<string, unknown> = {}) =>
  ({ flags, args: [] }) as unknown as Ctx;

/** A scratch store file, so no test can read or write the real ~/.config credential. */
function withStore<T>(fn: (storePath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liveone-target-"));
  try {
    return fn(path.join(dir, "cli-auth.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  delete process.env.LIVEONE_BASE_URL;
  delete process.env.LIVEONE_CLI_TOKEN;
});

describe("resolveOrigin precedence", () => {
  it("prefers the flag over everything", () => {
    process.env.LIVEONE_BASE_URL = "https://env.example";
    expect(resolveOrigin(ctx({ baseUrl: "http://localhost:3001/x" }))).toBe(
      "http://localhost:3001",
    );
  });

  it("falls back to the environment", () => {
    process.env.LIVEONE_BASE_URL = "https://env.example";
    expect(resolveOrigin(ctx())).toBe("https://env.example");
  });

  it("falls back to prod when nothing is configured", () => {
    withStore((storePath) => {
      expect(resolveOrigin(ctx(), { storePath })).toBe(DEFAULT_ORIGIN);
    });
  });

  it("remembers the store's default, so a dev laptop stays on dev", () => {
    withStore((storePath) => {
      setToken(
        "http://localhost:3001",
        {
          token: "lo_cli_x.y",
          tokenId: "t_1",
          userId: "u_1",
          email: null,
          label: "laptop",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        storePath,
      );
      expect(resolveOrigin(ctx(), { storePath })).toBe("http://localhost:3001");
      // ...except for `login`, where a bare invocation must mean prod rather than
      // "wherever I happened to log in last".
      expect(resolveOrigin(ctx(), { storePath, useStoredDefault: false })).toBe(
        DEFAULT_ORIGIN,
      );
    });
  });

  it("defaults to www, never the apex — auth headers do not survive its redirect", () => {
    expect(DEFAULT_ORIGIN).toBe("https://www.liveone.energy");
  });
});

describe("requireToken", () => {
  it("exits 3 with the login command when there is no token for the origin", () => {
    withStore((storePath) => {
      let detail: CliFailure["detail"] | undefined;
      try {
        requireToken("https://www.liveone.energy", { storePath });
      } catch (e) {
        if (!(e instanceof CliFailure)) throw e;
        detail = e.detail;
      }
      expect(detail?.what).toMatch(/not logged in/);
      expect(detail?.next).toMatch(
        /auth login --base-url=https:\/\/www\.liveone\.energy/,
      );
    });
  });

  it("appends a caller's alternative, so the db escape hatch is named where it applies", () => {
    withStore((storePath) => {
      try {
        requireToken("https://www.liveone.energy", {
          storePath,
          why: "the http transport needs a token",
          alsoTry: "(or use --via=db)",
        });
      } catch (e) {
        if (!(e instanceof CliFailure)) throw e;
        expect(e.detail.why).toBe("the http transport needs a token");
        expect(e.detail.next).toMatch(/--via=db/);
      }
    });
  });

  it("returns the stored entry when there is one", () => {
    withStore((storePath) => {
      setToken(
        "https://www.liveone.energy",
        {
          token: "lo_cli_x.y",
          tokenId: "t_1",
          userId: "u_1",
          email: null,
          label: "laptop",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        storePath,
      );
      expect(
        requireToken("https://www.liveone.energy", { storePath }).tokenId,
      ).toBe("t_1");
    });
  });
});
