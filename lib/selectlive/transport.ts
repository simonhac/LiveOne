import tls from "node:tls";
import type { Duplex } from "node:stream";
import { SelectLiveError, protocolError } from "./errors";

export const HOST = "select.live";
export const PORT = 7528;
export const TIMEOUT_MS = 15_000;

/** One reader; retain excess bytes across both CRLF and binary protocol boundaries. */
export class Channel {
  private buffer: Buffer = Buffer.alloc(0);
  private failure?: SelectLiveError;
  private wake?: () => void;
  private reading = false;
  private readonly abort = () =>
    this.fail(new SelectLiveError("interrupted", "Operation interrupted."));

  constructor(
    readonly socket: Duplex,
    readonly timeoutMs = TIMEOUT_MS,
    private signal?: AbortSignal,
  ) {
    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > 1024 * 1024) {
        this.fail(
          new SelectLiveError(
            "protocol",
            "Response exceeded the receive buffer limit.",
          ),
        );
      }
      this.wake?.();
    });
    socket.on("error", () =>
      this.fail(new SelectLiveError("network", "Connection failed.")),
    );
    socket.on("end", () =>
      this.fail(
        new SelectLiveError(
          "network",
          "Connection closed before the response completed.",
        ),
      ),
    );
    socket.on("close", () =>
      this.fail(new SelectLiveError("network", "Connection closed.")),
    );
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  private fail(error: SelectLiveError): void {
    this.failure ??= error;
    this.wake?.();
    this.socket.destroy();
  }

  write(data: Buffer | string): void {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  private async take(
    length: (data: Buffer) => number | undefined,
  ): Promise<Buffer> {
    if (this.reading)
      protocolError("Concurrent protocol reads are not supported.");
    this.reading = true;
    const timer = setTimeout(
      () =>
        this.fail(
          new SelectLiveError(
            "network",
            "Timed out waiting for a complete response.",
          ),
        ),
      this.timeoutMs,
    );
    try {
      while (true) {
        if (this.failure?.kind === "interrupted") throw this.failure;
        const count = length(this.buffer);
        if (count !== undefined) {
          const result = this.buffer.subarray(0, count);
          this.buffer = this.buffer.subarray(count);
          return result;
        }
        if (this.failure) throw this.failure;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      clearTimeout(timer);
      this.wake = undefined;
      this.reading = false;
    }
  }

  read(count: number): Promise<Buffer> {
    return this.take((data) => (data.length >= count ? count : undefined));
  }

  async line(): Promise<string> {
    const bytes = await this.take((data) => {
      const end = data.indexOf("\r\n");
      if (end >= 0 && end <= 8192) return end + 2;
      if (data.length > 8192)
        protocolError("Portal response line exceeded its limit.");
      return undefined;
    });
    return bytes.subarray(0, -2).toString("utf8");
  }

  close(): void {
    this.signal?.removeEventListener("abort", this.abort);
    this.fail(new SelectLiveError("network", "Connection closed."));
  }
}

export async function connect(signal?: AbortSignal): Promise<Channel> {
  if (signal?.aborted)
    throw new SelectLiveError("interrupted", "Operation interrupted.");
  const socket = tls.connect({
    host: HOST,
    port: PORT,
    servername: HOST,
    rejectUnauthorized: true,
  });
  const channel = new Channel(socket, TIMEOUT_MS, signal);
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: SelectLiveError) => {
      clearTimeout(timer);
      socket.removeListener("secureConnect", ready);
      socket.removeListener("error", failed);
      socket.removeListener("close", failed);
      if (error) {
        channel.close();
        reject(error);
      } else resolve();
    };
    const ready = () => finish();
    const failed = () =>
      finish(
        new SelectLiveError(
          signal?.aborted ? "interrupted" : "network",
          "Could not establish a verified TLS connection to Select.live.",
        ),
      );
    const timer = setTimeout(failed, TIMEOUT_MS);
    socket.once("secureConnect", ready);
    socket.once("error", failed);
    socket.once("close", failed);
  });
  return channel;
}

export interface PortalCredentials {
  email: string;
  password: string;
}
export interface PortalDevice {
  serial: string;
}

export function validateCredentials({
  email,
  password,
}: PortalCredentials): void {
  if (
    !email ||
    !password ||
    /[\x00-\x1f\x7f:]/.test(email) ||
    /[\x00-\x1f\x7f]/.test(password)
  ) {
    throw new SelectLiveError(
      "usage",
      "Email/password are empty or contain unsupported control characters.",
    );
  }
}

export class Portal {
  constructor(readonly channel: Channel) {}
  async login(credentials: PortalCredentials): Promise<void> {
    validateCredentials(credentials);
    if ((await this.channel.line()) !== "LOGIN")
      protocolError("Expected the Select.live login prompt.");
    this.channel.write(`USER:${credentials.email}:${credentials.password}\r\n`);
    const result = await this.channel.line();
    if (result === "REJECTED")
      throw new SelectLiveError(
        "auth",
        "Select.live rejected the portal login.",
      );
    if (result !== "OK")
      protocolError("Unexpected portal authentication response.");
  }
  async devices(): Promise<PortalDevice[]> {
    this.channel.write("LIST DEVICES\r\n");
    const header = /^DEVICES:(\d+)$/.exec(await this.channel.line());
    if (!header || Number(header[1]) > 1000)
      protocolError("Invalid device-list response.");
    const devices: PortalDevice[] = [];
    for (let i = 0; i < Number(header[1]); i++) {
      const match = /^DEVICE:(\d+)$/.exec(await this.channel.line());
      if (!match || devices.some((d) => d.serial === match[1]))
        protocolError("Invalid or duplicate inverter serial in device list.");
      devices.push({ serial: match[1] });
    }
    return devices;
  }
  async select(serial: string): Promise<void> {
    if (!/^\d+$/.test(serial))
      throw new SelectLiveError(
        "usage",
        "Device must be an inverter serial number.",
      );
    this.channel.write(`CONNECT:${serial}\r\n`);
    const reply = await this.channel.line();
    if (reply === "OFFLINE")
      throw new SelectLiveError("offline", "The inverter is offline.");
    if (reply === "BUSY")
      throw new SelectLiveError(
        "busy",
        "The inverter connection is busy; close other SP LINK sessions and retry.",
      );
    if (reply === "REJECTED")
      throw new SelectLiveError(
        "auth",
        "Select.live rejected access to this inverter.",
      );
    if (reply !== "READY")
      protocolError("Unexpected inverter connection response.");
  }
  close(): void {
    this.channel.close();
  }
}

export function selectDevice(devices: PortalDevice[], serial?: string): string {
  if (serial) {
    if (!devices.some((d) => d.serial === serial))
      throw new SelectLiveError(
        "usage",
        "The requested inverter is not in this account's device list.",
      );
    return serial;
  }
  if (devices.length !== 1)
    throw new SelectLiveError(
      "usage",
      devices.length
        ? "Multiple inverters are available; pass --device SERIAL."
        : "No inverters are available to this account.",
    );
  return devices[0].serial;
}
