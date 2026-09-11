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
