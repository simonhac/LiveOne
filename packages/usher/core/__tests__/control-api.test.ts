/**
 * The control route handlers: auth layering, capability disclosure, lazy passkey resolution.
 * (Control DECISIONS are covered in control.test.ts — these tests stop at the supervisor boundary.)
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { handleNoopPost, handleRunGet, handleRunPost } from "../control-api";
import { RunSupervisor } from "../control";
import { registry } from "../../state/registry";
import type {
  SourceControl,
  ControlOwnership,
  ControlPreflight,
} from "../source";

const PASSKEY = "correct-horse-battery-staple";

function fakeTarget(): SourceControl {
  const ownership: ControlOwnership = {
    mode: 1,
    modeName: "Auto",
    remoteStartInput: "open",
    running: false,
  };
  const preflight: ControlPreflight = {
    ownership,
    scfMap: [0xffff, 0xffff, 0, 0, 0, 0, 0, 0],
    scfSupported: {
      selectAuto: true,
      telemetryStart: true,
      telemetryCancel: true,
    },
  };
  return {
    start: async () => {},
    stop: async () => {},
    readOwnership: async () => ownership,
    preflight: async () => preflight,
  };
}

function post(siteId: string, body: unknown): Promise<Response> {
  return handleRunPost(
    new Request("http://localhost/api/usher/control/x/run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    siteId,
  );
}

describe("control route handlers", () => {
  let dir: string;
  let sup: RunSupervisor;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "usher-control-api-"));
    process.env.TEST_CONTROL_KEY = PASSKEY;
    delete process.env.CF_ACCESS_TEAM_DOMAIN; // origin JWT check off for these tests
    delete process.env.CF_ACCESS_AUD;
    sup = new RunSupervisor({
      siteId: "testsite",
      target: fakeTarget(),
      config: { passkeyEnv: "TEST_CONTROL_KEY", maxRuntimeSec: 3600 },
      dataDir: dir,
    });
    registry.supervisors.clear();
    registry.supervisors.set("testsite", sup);
  });

  afterEach(async () => {
    sup.dispose();
    registry.supervisors.clear();
    delete process.env.TEST_CONTROL_KEY;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("404s an unknown site AND a control-less site identically (no capability disclosure)", async () => {
    const res = await post("nope", { passkey: PASSKEY, runtimeSec: 60 });
    expect(res.status).toBe(404);
  });

  it("401s a wrong passkey", async () => {
    const res = await post("testsite", { passkey: "wrong", runtimeSec: 60 });
    expect(res.status).toBe(401);
  });

  it("401s a missing passkey", async () => {
    const res = await post("testsite", { runtimeSec: 60 });
    expect(res.status).toBe(401);
  });

  it("503s when the passkey env is unset — control degrades, it never throws at startup", async () => {
    delete process.env.TEST_CONTROL_KEY;
    const res = await post("testsite", { passkey: PASSKEY, runtimeSec: 60 });
    expect(res.status).toBe(503);
  });

  it("400s malformed JSON and a missing runtimeSec", async () => {
    const bad = await handleRunPost(
      new Request("http://localhost/x", { method: "POST", body: "{oops" }),
      "testsite",
    );
    expect(bad.status).toBe(400);
    const missing = await post("testsite", { passkey: PASSKEY });
    expect(missing.status).toBe(400);
  });

  it("400s an over-max runtime, naming the max in the reason", async () => {
    const res = await post("testsite", { passkey: PASSKEY, runtimeSec: 3601 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toContain("3600");
  });

  it("starts a run and reports the absolute stop instant", async () => {
    const res = await post("testsite", { passkey: PASSKEY, runtimeSec: 120 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      action: string;
      stopAt: string;
      status: { latched: boolean; state: string };
    };
    expect(body.ok).toBe(true);
    expect(body.action).toBe("started");
    expect(Date.parse(body.stopAt)).toBeGreaterThan(Date.now());
    expect(body.status.latched).toBe(true);
  });

  it("runtimeSec 0 releases", async () => {
    await post("testsite", { passkey: PASSKEY, runtimeSec: 120 });
    const res = await post("testsite", { passkey: PASSKEY, runtimeSec: 0 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: string; released: boolean };
    expect(body.action).toBe("released");
    expect(body.released).toBe(true);
  });

  it("GET reports status with the passkey in x-usher-passkey", async () => {
    const unauth = await handleRunGet(
      new Request("http://localhost/x"),
      "testsite",
    );
    expect(unauth.status).toBe(401);
    const res = await handleRunGet(
      new Request("http://localhost/x", {
        headers: { "x-usher-passkey": PASSKEY },
      }),
      "testsite",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      latched: boolean;
      maxRuntimeSec: number;
    };
    expect(body.latched).toBe(false);
    expect(body.maxRuntimeSec).toBe(3600);
  });

  describe("noop probe", () => {
    const noop = (headers: Record<string, string> = {}, body?: unknown) =>
      handleNoopPost(
        new Request("http://localhost/x", {
          method: "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        "testsite",
      );

    it("requires the passkey like every other control call", async () => {
      expect((await noop()).status).toBe(401);
      expect((await noop({}, { passkey: "wrong" })).status).toBe(401);
    });

    it("accepts the passkey in a header (no body needed) and reports the verdict", async () => {
      const res = await noop({ "x-usher-passkey": PASSKEY });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        wouldStart: boolean;
        verdict: string;
        hypotheticalRuntimeSec: number;
        preflight: { ownership: { modeName: string } };
      };
      expect(body.ok).toBe(true);
      expect(body.wouldStart).toBe(true);
      expect(body.hypotheticalRuntimeSec).toBe(60);
      expect(body.preflight.ownership.modeName).toBe("Auto");
      expect(body.verdict).toContain("would START");
    });

    it("leaves the supervisor completely untouched", async () => {
      const before = JSON.stringify(sup.status());
      await noop({ "x-usher-passkey": PASSKEY }, { runtimeSec: 300 });
      expect(JSON.stringify(sup.status())).toBe(before);
    });

    it("404s an unknown site, like the run route", async () => {
      const res = await handleNoopPost(
        new Request("http://localhost/x", {
          method: "POST",
          headers: { "x-usher-passkey": PASSKEY },
        }),
        "nope",
      );
      expect(res.status).toBe(404);
    });
  });

  it("401s when Access verification is configured but the JWT header is absent", async () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "aud123";
    try {
      const res = await post("testsite", { passkey: PASSKEY, runtimeSec: 60 });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Cf-Access-Jwt-Assertion");
    } finally {
      delete process.env.CF_ACCESS_TEAM_DOMAIN;
      delete process.env.CF_ACCESS_AUD;
    }
  });
});
