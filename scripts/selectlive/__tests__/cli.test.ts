import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, renderHelp, type Ctx } from "@/lib/cli/cli";
import { selectliveCommand } from "../commands";
import { executeSelectlive, type Dependencies } from "../handlers";
import { readCredentials, saveCredentials } from "@/lib/selectlive/credentials";
import { simulated } from "@/lib/selectlive/__tests__/fixtures";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "selectlive-cli-test-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function context(argv: string[]): Ctx {
  const result = parse(selectliveCommand, argv, {
    stdinIsTTY: false,
    stdoutIsTTY: false,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return {
    ...result,
    subcommand: result.subcommandPath.at(-1),
    emit: jest.fn(),
    note: jest.fn(),
    warn: jest.fn(),
    confirm: jest.fn(),
  } as unknown as Ctx;
}
function deps(reply = "OK"): Dependencies {
  return {
    env: {
      SELECTLIVE_EMAIL: "test@example.com",
      SELECTLIVE_PASSWORD: "test-secret",
    },
    storePath: path.join(root, "credentials.json"),
    prompt: jest.fn(),
    connect: jest.fn(async () => {
      const { socket, channel } = simulated((message, stream) => {
        if (message.toString().startsWith("USER:")) stream.push(reply + "\r\n");
        else if (message.toString().startsWith("LIST DEVICES"))
          stream.push("DEVICES:1\r\nDEVICE:123\r\n");
        else stream.push("OFFLINE\r\n");
      });
      socket.push("LOGIN\r\n");
      return channel;
    }),
  };
}
it("supports bare auth and saves only after successful verification", async () => {
  const dependencies = deps();
  const ctx = context(["auth"]);
  expect(await executeSelectlive(ctx, dependencies)).toBe(0);
  expect(readCredentials(dependencies.storePath)?.email).toBe(
    "test@example.com",
  );
  expect(JSON.stringify((ctx.emit as jest.Mock).mock.calls)).not.toContain(
    "test-secret",
  );
});
it("failed authentication preserves the existing credential file byte-for-byte", async () => {
  const dependencies = deps("REJECTED");
  saveCredentials(
    {
      version: 1,
      email: "old@example.com",
      password: "old-secret",
      inverterPasswords: {},
    },
    dependencies.storePath,
  );
  const before = fs.readFileSync(dependencies.storePath);
  await expect(
    executeSelectlive(context(["auth"]), dependencies),
  ).rejects.toMatchObject({ kind: "auth" });
  expect(fs.readFileSync(dependencies.storePath)).toEqual(before);
});
it("status uses the saved account and logout makes no network call", async () => {
  const dependencies = deps();
  saveCredentials(
    {
      version: 1,
      email: "saved@example.com",
      password: "saved-secret",
      inverterPasswords: {},
    },
    dependencies.storePath,
  );
  const ctx = context(["auth", "status"]);
  await executeSelectlive(ctx, dependencies);
  expect((ctx.emit as jest.Mock).mock.calls[0][0].email).toBe(
    "saved@example.com",
  );
  (dependencies.connect as jest.Mock).mockClear();
  await executeSelectlive(context(["auth", "logout"]), dependencies);
  expect(dependencies.connect).not.toHaveBeenCalled();
  expect(readCredentials(dependencies.storePath)).toBeUndefined();
});
it("checks invalid auth actions and filters before making a connection", async () => {
  const dependencies = deps();
  await expect(
    executeSelectlive(context(["auth", "oops"]), dependencies),
  ).rejects.toMatchObject({ kind: "usage" });
  await expect(
    executeSelectlive(
      context(["history", "download", "--out", root, "--start", "2026-09-10"]),
      dependencies,
    ),
  ).rejects.toMatchObject({ kind: "usage" });
  expect(dependencies.connect).not.toHaveBeenCalled();
});
it("rejects unknown flags and invalid word counts and addresses", () => {
  for (const argv of [
    ["read", "--address", "0", "--words", "257"],
    ["read", "--address", "-1", "--words", "1"],
    ["devices", "--write"],
    ["auth", "--password", "secret"],
  ]) {
    expect(
      parse(selectliveCommand, argv, { stdinIsTTY: false, stdoutIsTTY: false })
        .ok,
    ).toBe(false);
  }
});
it("documents local effects and direct Select.live access", () => {
  expect(renderHelp(selectliveCommand)).toContain("select.live:7528");
  expect(renderHelp(selectliveCommand.subcommands!.auth)).not.toContain(
    "This command changes nothing",
  );
});

it("refuses an incomplete environment override before opening a socket", async () => {
  const dependencies = deps();
  dependencies.env = { SELECTLIVE_EMAIL: "test@example.com" };
  await expect(
    executeSelectlive(context(["auth"]), dependencies),
  ).rejects.toMatchObject({ kind: "usage" });
  expect(dependencies.connect).not.toHaveBeenCalled();
});

it.each([true, false])(
  "saves inverter credentials only when the inverter accepts them (%s)",
  async (accepted) => {
    const { appendCrc } = await import("@/lib/selectlive/protocol");
    const dependencies = deps();
    dependencies.env = {
      ...dependencies.env,
      SELECTLIVE_INVERTER_PASSWORD: "inverter-test-secret",
    };
    saveCredentials(
      {
        version: 1,
        email: "test@example.com",
        password: "old-secret",
        inverterPasswords: { "456": "another-secret" },
      },
      dependencies.storePath,
    );
    const before = fs.readFileSync(dependencies.storePath);
    const sent: Buffer[] = [];
    dependencies.connect = async () => {
      let binary = false;
      const { channel, socket } = simulated((message, stream) => {
        sent.push(message);
        if (!binary) {
          if (message.toString().startsWith("USER:")) stream.push("OK\r\n");
          else if (message.toString().startsWith("LIST DEVICES"))
            stream.push("DEVICES:1\r\nDEVICE:123\r\n");
          else {
            binary = true;
            stream.push("READY\r\n");
          }
        } else if (message[0] === 87) stream.push(message);
        else {
          const data = Buffer.alloc((message[1] + 1) * 2);
          if (message.readUInt32LE(2) === 0x1f0010)
            data.writeUInt16LE(accepted ? 1 : 0);
          stream.push(appendCrc(Buffer.concat([message, data])));
        }
      });
      socket.push("LOGIN\r\n");
      return channel;
    };
    const ctx = context(["auth", "--device", "123"]);
    if (accepted) {
      expect(await executeSelectlive(ctx, dependencies)).toBe(0);
      expect(
        readCredentials(dependencies.storePath)?.inverterPasswords,
      ).toEqual({ "123": "inverter-test-secret", "456": "another-secret" });
      expect(JSON.stringify((ctx.emit as jest.Mock).mock.calls)).not.toContain(
        "secret",
      );
    } else {
      await expect(executeSelectlive(ctx, dependencies)).rejects.toMatchObject({
        kind: "auth",
      });
      expect(fs.readFileSync(dependencies.storePath)).toEqual(before);
    }
    expect(
      sent
        .filter((frame) => frame[0] === 87)
        .map((frame) => frame.readUInt32LE(2)),
    ).toEqual([0x1f0000]);
  },
);

/**
 * A scripted inverter that answers any read with zeros, recording every frame sent.
 *
 * Reused by the configuration tests below, whose entire point is what is NOT sent.
 */
async function invertedSession(values: Record<number, number> = {}) {
  const { appendCrc } = await import("@/lib/selectlive/protocol");
  const sent: Buffer[] = [];
  const connect = async () => {
    let binary = false;
    const { channel, socket } = simulated((message, stream) => {
      sent.push(message);
      if (!binary) {
        if (message.toString().startsWith("USER:")) stream.push("OK\r\n");
        else if (message.toString().startsWith("LIST DEVICES"))
          stream.push("DEVICES:1\r\nDEVICE:123\r\n");
        else {
          binary = true;
          stream.push("READY\r\n");
        }
        return;
      }
      if (message[0] === 87) {
        stream.push(message);
        return;
      }
      const words = message[1] + 1;
      const address = message.readUInt32LE(2);
      const data = Buffer.alloc(words * 2);
      if (address === 0x1f0010) data.writeUInt16LE(1);
      // Identity: serial 123, model code 0 (SPMC482), and a supported settings version.
      if (address === 0xa05d) {
        data.writeUInt16LE(0, 0);
        data.writeUInt32LE(123, 2);
      }
      if (address === 0xa007) data.writeUInt16LE(51, 0);
      for (let i = 0; i < words; i++) {
        const value = values[address + i];
        if (value !== undefined) data.writeUInt16LE(value, i * 2);
      }
      stream.push(appendCrc(Buffer.concat([message, data])));
    });
    socket.push("LOGIN\r\n");
    return channel;
  };
  return { sent, connect };
}

const writesIn = (sent: Buffer[]) =>
  sent.filter((frame) => frame[0] === 87).map((frame) => frame.readUInt32LE(2));

it("reads the configuration without writing anything but the login challenge", async () => {
  const dependencies = deps();
  // 0xc18b is BulkChargeI; 0xc18a is BulkChargeV, scaled by the model's 24 cells.
  const { sent, connect } = await invertedSession({
    0xc18b: 100,
    0xc18a: 2400,
  });
  dependencies.connect = connect;
  const ctx = context(["config", "show", "--device", "123"]);
  await executeSelectlive(ctx, dependencies);

  // 🛑 The read-only contract's teeth. `config` touches five new memory ranges, and the only
  // write frame the whole client may ever send is the authentication challenge.
  expect(writesIn(sent)).toEqual([0x1f0000]);

  const model = (ctx.emit as jest.Mock).mock.calls[0][0];
  const setting = (name: string) =>
    model.settings.find((s: { name: string }) => s.name === name);
  expect(setting("BulkChargeI")).toMatchObject({
    value: 100,
    status: "decoded",
  });
  expect(setting("BulkChargeV")).toMatchObject({ value: 57.6, unit: "V" });
});

it("reads exactly the five configuration blocks, twice, and nothing else nearby", async () => {
  const dependencies = deps();
  const { sent, connect } = await invertedSession();
  dependencies.connect = connect;
  await executeSelectlive(
    context(["config", "show", "--device", "123"]),
    dependencies,
  );

  const configReads = sent
    .filter((frame) => {
      const address = frame.readUInt32LE(2);
      return frame[0] === 81 && address >= 0xc000 && address < 0xd000;
    })
    .map((frame) => [frame.readUInt32LE(2), frame[1] + 1]);
  // Read once to report, once more to prove the snapshot did not move underneath us.
  expect(configReads).toEqual([
    [0xc000, 197],
    [0xc0e5, 18],
    [0xc100, 125],
    [0xc180, 60],
    [0xc800, 193],
    [0xc000, 197],
    [0xc0e5, 18],
    [0xc100, 125],
    [0xc180, 60],
    [0xc800, 193],
  ]);
  // The gap between the two common reads is never touched.
  expect(
    configReads.some(([address]) => address > 0xc0c4 && address < 0xc0e5),
  ).toBe(false);
});

it("writes a configuration download without ever writing to the inverter", async () => {
  const dependencies = deps();
  const { sent, connect } = await invertedSession({ 0xc18b: 100 });
  dependencies.connect = connect;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "selectlive-config-test-"));
  const ctx = context(["config", "download", "--device", "123", "--out", out]);
  await executeSelectlive(ctx, dependencies);

  expect(writesIn(sent)).toEqual([0x1f0000]);
  const directory = (ctx.emit as jest.Mock).mock.calls[0][0]
    .directory as string;
  // Raw evidence, its digest, and the decoded views all land.
  for (const file of [
    "manifest.json",
    "blocks.jsonl",
    "settings.csv",
    "unmapped.csv",
  ])
    expect(fs.existsSync(path.join(directory, file))).toBe(true);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  expect(manifest.verification).toBe("stable");
  expect(manifest.complete).toBe(true);
  expect(manifest.rawSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(
    fs.readFileSync(path.join(directory, "settings.csv"), "utf8"),
  ).toContain("BulkChargeI");
});

it("rejects a configuration download with no --out before opening a socket", async () => {
  const dependencies = deps();
  await expect(
    executeSelectlive(
      context(["config", "download", "--device", "123", "--out", "   "]),
      dependencies,
    ),
  ).rejects.toMatchObject({ kind: "usage" });
  expect(dependencies.connect).not.toHaveBeenCalled();
});

it("applies --all to the emitted model, not just the human renderer", async () => {
  // 🛑 JSON is the default whenever stdout is not a terminal, and `ctx.emit` serialises its
  // first argument without consulting the renderer. Building the model from every setting made
  // `--all` a no-op for exactly the scripted callers it matters to, and handed them the
  // opposite of the documented curated default.
  const curated = deps();
  const a = await invertedSession();
  curated.connect = a.connect;
  const curatedCtx = context(["config", "show", "--device", "123"]);
  await executeSelectlive(curatedCtx, curated);
  const curatedModel = (curatedCtx.emit as jest.Mock).mock.calls[0][0];

  const all = deps();
  const b = await invertedSession();
  all.connect = b.connect;
  const allCtx = context(["config", "show", "--device", "123", "--all"]);
  await executeSelectlive(allCtx, all);
  const allModel = (allCtx.emit as jest.Mock).mock.calls[0][0];

  expect(curatedModel.settings.length).toBeLessThan(allModel.settings.length);
  expect(allModel.settings.length).toBe(allModel.coverage.settings);
  // The curated view is still the useful one: it carries the charge settings.
  expect(
    curatedModel.settings.some(
      (s: { name: string }) => s.name === "BulkChargeI",
    ),
  ).toBe(true);
});

it("reports a failed verification read as unverified, not as a changed configuration", async () => {
  // 🛑 `readConfig` records a failed block instead of throwing, so a transient error on the
  // second pass makes the two reads differ. Calling that "changed" would assert a
  // configuration change on no evidence — the one claim somebody would act on.
  const dependencies = deps();
  let pass = 0;
  const { connect } = await invertedSession();
  dependencies.connect = async (signal?: AbortSignal) => {
    const channel = await connect();
    const realWrite = channel.write.bind(channel);
    channel.write = (frame: Buffer) => {
      const address = frame[0] === 81 ? frame.readUInt32LE(2) : 0;
      // Fail the battery block, but only on the verification pass.
      if (address === 0xc180 && ++pass === 2) throw new Error("transient");
      return realWrite(frame);
    };
    void signal;
    return channel;
  };
  const ctx = context(["config", "show", "--device", "123"]);
  await executeSelectlive(ctx, dependencies);
  const model = (ctx.emit as jest.Mock).mock.calls[0][0];
  expect(model.verification).toBe("unverified");
});
