import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "node:events";
import {
  armSocketForensics,
  formatConnectionPath,
  probeConnectionPath,
} from "../connection-forensics";

/** A stand-in for pg's Client: `connection.stream` is the socket, `_ending` the flag. */
function fakeClient() {
  const socket = Object.assign(new EventEmitter(), {
    bytesRead: 677,
    bytesWritten: 254,
  });
  const client = {
    _ending: false,
    connection: { stream: socket, _ending: false },
  };
  return { client, socket };
}

function capture() {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
}

const death = (lines: string[]) =>
  lines.filter((l) => l.includes("socket-death"));

describe("armSocketForensics", () => {
  it("stays silent when WE close the connection (pool idle-reap / end())", () => {
    const { client, socket } = fakeClient();
    const { lines, log } = capture();
    armSocketForensics(client, "pool", log);

    // pg sets _ending in Client.end() before the socket tears down.
    client._ending = true;
    socket.emit("end");
    socket.emit("close", false);

    expect(death(lines)).toHaveLength(0);
  });

  it("REPORTS a real dropout even though the caller's finally later calls end()", () => {
    // Regression: deciding at 'close' time would misread this as our own shutdown,
    // because the failing query rejects a tick before `finally` runs end().
    const { client, socket } = fakeClient();
    const { lines, log } = capture();
    const probe = armSocketForensics(client, "sync:prod", log);
    probe.setPhase("point_readings: COPY OUT, then idle");

    socket.emit("end"); // peer FIN arrives while _ending is still false
    client._ending = true; // ...then the finally block ends the client
    socket.emit("close", false);

    const [line] = death(lines);
    expect(line).toBeDefined();
    const payload = JSON.parse(line.slice(line.indexOf("{")));
    expect(payload.sawFin).toBe(true);
    expect(payload.hadError).toBe(false);
    expect(payload.shape).toMatch(/^FIN/);
    expect(payload.phase).toBe("point_readings: COPY OUT, then idle");
  });

  it("reports an RST as network-shaped", () => {
    const { client, socket } = fakeClient();
    const { lines, log } = capture();
    armSocketForensics(client, "sync:dev", log);

    socket.emit("error", new Error("read ECONNRESET"));
    socket.emit("close", true);

    const payload = JSON.parse(
      death(lines)[0].slice(death(lines)[0].indexOf("{")),
    );
    expect(payload.hadError).toBe(true);
    expect(payload.shape).toMatch(/^RST/);
  });

  it("defaults phase to (not tracked) rather than claiming no work started", () => {
    const { client, socket } = fakeClient();
    const { lines, log } = capture();
    armSocketForensics(client, "pool", log);

    socket.emit("error", new Error("boom"));
    socket.emit("close", true);

    expect(death(lines)[0]).toContain('"phase":"(not tracked)"');
  });

  it("degrades quietly when there is no socket", () => {
    const { lines, log } = capture();
    expect(() => armSocketForensics({}, "x", log)).not.toThrow();
    expect(lines[0]).toContain("probe unavailable");
  });
});

describe("probeConnectionPath", () => {
  const row = {
    server_addr: "10.0.0.1",
    backend_pid: 42,
    statement_limit: "0",
    idle_txn_limit: "0",
    idle_session_limit: "0",
    keepalives_idle: "7200",
    server_version: "17.10",
  };

  it("calls a port mismatch 'pooled' — the only sound positive", async () => {
    const client = {
      query: async () => ({ rows: [{ ...row, server_port: 5432 }] }),
    };
    const info = await probeConnectionPath(client, "postgres://h:6432/d");
    expect(info?.portMismatch).toBe(true);
    expect(info?.verdict).toBe("pooled");
  });

  it("never claims 'direct' — equal ports are only 'inconclusive'", async () => {
    const client = {
      query: async () => ({ rows: [{ ...row, server_port: 5432 }] }),
    };
    const info = await probeConnectionPath(client, "postgres://h:5432/d");
    expect(info?.portMismatch).toBe(false);
    expect(info?.verdict).toBe("inconclusive");
  });

  it("treats a portless URL as pg's 5432 default", async () => {
    const client = {
      query: async () => ({ rows: [{ ...row, server_port: 5432 }] }),
    };
    expect((await probeConnectionPath(client, "postgres://h/d"))?.verdict).toBe(
      "inconclusive",
    );
  });

  it("is fail-safe: a probe error returns null, never throws", async () => {
    const client = {
      query: async () => {
        throw new Error("connection is dead");
      },
    };
    await expect(probeConnectionPath(client, "")).resolves.toBeNull();
  });
});

describe("formatConnectionPath", () => {
  it("never leaks the server address (Actions logs are public)", async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            server_addr: "10.9.9.9",
            server_port: 5432,
            backend_pid: 1,
            statement_limit: "0",
            idle_txn_limit: "0",
            idle_session_limit: "0",
            keepalives_idle: "7200",
            server_version: "17.10",
          },
        ],
      }),
    };
    const info = await probeConnectionPath(client, "postgres://h:5432/d");
    const formatted = formatConnectionPath(info!);
    expect(formatted).not.toContain("10.9.9.9");
    expect(formatted).not.toContain("serverAddr");
    expect(formatted).toContain('"verdict":"inconclusive"');
  });

  it("emits no field containing the classifier's 'timeout' keyword", async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            server_addr: null,
            server_port: 5432,
            backend_pid: 1,
            statement_limit: "0",
            idle_txn_limit: "0",
            idle_session_limit: "0",
            keepalives_idle: "7200",
            server_version: "17.10",
          },
        ],
      }),
    };
    const info = await probeConnectionPath(client, "postgres://h:5432/d");
    expect(formatConnectionPath(info!)).not.toMatch(/timed? ?out|timeout/i);
  });
});
