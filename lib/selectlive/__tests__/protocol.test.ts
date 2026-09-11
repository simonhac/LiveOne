import { Duplex } from "node:stream";
import { Channel, Portal, selectDevice } from "../transport";
import {
  appendCrc,
  challengeResponse,
  crc16,
  Inverter,
  request,
} from "../protocol";

import { simulated } from "./fixtures";

describe("SP PRO framing and authentication", () => {
  it("matches the independently published hello frame", () => {
    expect(request("Q", 0xa000, 1).toString("hex")).toBe("510000a000009d4b");
    expect(crc16(Buffer.from("510000a000009d4b0100d819", "hex"))).toBe(0);
    expect(request("Q", 0xffffffff, 1).length).toBe(8);
    expect(() => request("Q", 0xffffffff, 2)).toThrow(/overflowing/);
    for (const count of [0, 257, 1.5])
      expect(() => request("Q", 0, count)).toThrow();
  });
  it("buffers fragmented binary responses and authenticates with only the challenge write", async () => {
    const sent: Buffer[] = [];
    const challenge = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const { channel, socket } = simulated((frame, stream) => {
      sent.push(frame);
      const address = frame.readUInt32LE(2);
      if (frame[0] === 87) {
        stream.push(frame);
        return;
      }
      const data = address === 0x1f0000 ? challenge : Buffer.from([1, 0]);
      const response = appendCrc(Buffer.concat([frame, data]));
      stream.push(response.subarray(0, 3));
      setImmediate(() => stream.push(response.subarray(3)));
    });
    try {
      await new Inverter(channel).login("Selectronic SP PRO");
      const writes = sent.filter((f) => f[0] === 87);
      expect(writes).toHaveLength(1);
      expect(writes[0].readUInt32LE(2)).toBe(0x1f0000);
      expect(writes[0].subarray(8, -2)).toEqual(
        challengeResponse(challenge, "Selectronic SP PRO"),
      );
      expect(crc16(writes[0])).toBe(0);
    } finally {
      channel.close();
      socket.destroy();
    }
  });
  it.each(["crc", "echo"])("rejects a corrupt %s response", async (kind) => {
    const { channel } = simulated((frame, stream) => {
      const response = appendCrc(Buffer.concat([frame, Buffer.from([42, 0])]));
      response[kind === "crc" ? response.length - 1 : 2] ^= 1;
      stream.push(response);
    });
    try {
      await expect(new Inverter(channel).query(0xa000, 1)).rejects.toThrow(
        kind === "crc" ? /CRC/ : /echo/,
      );
    } finally {
      channel.close();
    }
  });
  it("rejects an incorrect inverter password", async () => {
    const { channel } = simulated((frame, stream) => {
      stream.push(
        frame[0] === 87
          ? frame
          : appendCrc(Buffer.concat([frame, Buffer.alloc((frame[1] + 1) * 2)])),
      );
    });
    try {
      await expect(new Inverter(channel).login("wrong")).rejects.toMatchObject({
        kind: "auth",
      });
    } finally {
      channel.close();
    }
  });
});

describe("buffered Select.live transport", () => {
  it("handles fragmented login and coalesced device lines and binary data", async () => {
    const { channel, socket } = simulated((data, stream) => {
      if (data.toString().startsWith("USER:")) stream.push("OK\r\n");
      else if (data.toString() === "LIST DEVICES\r\n")
        stream.push("DEVICES:2\r\nDEVICE:123\r\nDEVICE:456\r\n");
      else
        stream.push(
          Buffer.concat([Buffer.from("READY\r\n"), Buffer.from([10, 20])]),
        );
    });
    socket.push("LO");
    setImmediate(() => socket.push("GIN\r\n"));
    const portal = new Portal(channel);
    try {
      await portal.login({ email: "test@example.com", password: "secret" });
      expect(await portal.devices()).toEqual([
        { serial: "123" },
        { serial: "456" },
      ]);
      await portal.select("123");
      expect(await channel.read(2)).toEqual(Buffer.from([10, 20]));
    } finally {
      portal.close();
    }
  });
  it.each([
    ["OFFLINE", "offline"],
    ["BUSY", "busy"],
    ["REJECTED", "auth"],
  ])("distinguishes %s", async (reply, kind) => {
    const { channel } = simulated((_, stream) => stream.push(reply + "\r\n"));
    try {
      await expect(new Portal(channel).select("123")).rejects.toMatchObject({
        kind,
      });
    } finally {
      channel.close();
    }
  });
  it("does not echo server payloads in authentication errors", async () => {
    const { channel, socket } = simulated((_, stream) =>
      stream.push("unexpected-secret\r\n"),
    );
    socket.push("LOGIN\r\n");
    try {
      await expect(
        new Portal(channel).login({
          email: "test@example.com",
          password: "unexpected-secret",
        }),
      ).rejects.toThrow("Unexpected portal authentication response.");
    } finally {
      channel.close();
    }
  });
  it("times out a partially received response and closes the socket", async () => {
    const { channel, socket } = simulated(() => {}, 20);
    socket.push("LOGIN\r");
    await expect(channel.line()).rejects.toMatchObject({ kind: "network" });
    expect(socket.destroyed).toBe(true);
    channel.close();
  });
  it("rejects a disconnect in the middle of a binary response", async () => {
    const { channel } = simulated((_, stream) => {
      stream.push(Buffer.from([1]));
      stream.push(null);
    });
    try {
      await expect(new Inverter(channel).query(1, 1)).rejects.toMatchObject({
        kind: "network",
      });
    } finally {
      channel.close();
    }
  });
  it("cancels a pending read", async () => {
    const controller = new AbortController();
    const socket = new Duplex({
      read() {},
      write(_, _e, cb) {
        cb();
      },
    });
    const channel = new Channel(socket, 1000, controller.signal);
    const read = channel.read(2);
    controller.abort();
    await expect(read).rejects.toMatchObject({ kind: "interrupted" });
    expect(socket.destroyed).toBe(true);
    channel.close();
  });
  it("requires an unambiguous device selection", () => {
    expect(selectDevice([{ serial: "123" }])).toBe("123");
    expect(() => selectDevice([])).toThrow(/No inverters/);
    expect(() => selectDevice([{ serial: "1" }, { serial: "2" }])).toThrow(
      /Multiple/,
    );
    expect(() => selectDevice([{ serial: "1" }], "2")).toThrow(/not in/);
  });
});

it("matches an independent MD5 challenge-response vector", () => {
  expect(
    challengeResponse(
      Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"),
      "Selectronic SP PRO",
    ).toString("hex"),
  ).toBe("d2aea0c33d005ff45d8faf0d2ce92991");
  expect(() => challengeResponse(Buffer.alloc(16), "x".repeat(33))).toThrow(
    /1–32/,
  );
});

it("rejects oversized lines and overlapping protocol reads", async () => {
  const { channel, socket } = simulated(() => {});
  socket.push("x".repeat(8193));
  await expect(channel.line()).rejects.toThrow(/limit/);
  channel.close();
  const second = simulated(() => {});
  const pending = second.channel.read(2);
  await expect(second.channel.read(2)).rejects.toThrow(/Concurrent/);
  second.channel.close();
  await expect(pending).rejects.toThrow(/closed/);
});
