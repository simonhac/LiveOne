import { createHash } from "node:crypto";
import { Channel } from "./transport";
import { SelectLiveError, protocolError } from "./errors";

/** Reflected CRC-16 (0x8408), initial zero, no final XOR; wire CRC is little-endian.
 * Framing/authentication reference: neerolyte/selpi (MIT), see NOTICE.md.
 */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0x8408 : 0);
  }
  return crc;
}
export function appendCrc(data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 2);
  data.copy(result);
  result.writeUInt16LE(crc16(data), data.length);
  return result;
}
export function request(
  type: "Q" | "W",
  address: number,
  words: number,
): Buffer {
  if (
    !Number.isInteger(address) ||
    address < 0 ||
    address > 0xffffffff ||
    !Number.isInteger(words) ||
    words < 1 ||
    words > 256 ||
    address + words - 1 > 0xffffffff
  ) {
    throw new SelectLiveError(
      "usage",
      "Reads require a uint32 word address and a count of 1–256 words without overflowing the address space.",
    );
  }
  const data = Buffer.alloc(6);
  data[0] = type.charCodeAt(0);
  data[1] = words - 1;
  data.writeUInt32LE(address, 2);
  return appendCrc(data);
}
export function wordsFrom(data: Buffer): number[] {
  if (data.length % 2) protocolError("Odd-length word buffer.");
  return Array.from({ length: data.length / 2 }, (_, i) =>
    data.readUInt16LE(i * 2),
  );
}
export function challengeResponse(challenge: Buffer, password: string): Buffer {
  if (challenge.length !== 16)
    protocolError("Invalid inverter challenge length.");
  const bytes = Buffer.from(password, "utf8");
  if (!bytes.length || bytes.length > 32)
    throw new SelectLiveError(
      "usage",
      "Inverter password must contain 1–32 UTF-8 bytes.",
    );
  const padded = Buffer.alloc(32, 0x20);
  bytes.copy(padded);
  const digest = createHash("md5").update(challenge).update(padded).digest();
  return digest.swap16();
}
export interface MemoryReader {
  query(address: number, words: number): Promise<Buffer>;
}
export class Inverter implements MemoryReader {
  constructor(private channel: Channel) {}
  async query(address: number, words: number): Promise<Buffer> {
    const frame = request("Q", address, words);
    this.channel.write(frame);
    const response = await this.channel.read(frame.length + words * 2 + 2);
    if (!response.subarray(0, frame.length).equals(frame))
      protocolError(
        "Inverter response did not echo the requested address and length.",
      );
    if (crc16(response) !== 0)
      protocolError("Inverter response failed its CRC check.");
    return response.subarray(frame.length, -2);
  }
  async login(password: string): Promise<void> {
    // The only write supported by this client: the authentication challenge mailbox.
    const challenge = await this.query(0x1f0000, 8);
    const digest = challengeResponse(challenge, password);
    const frame = appendCrc(Buffer.concat([request("W", 0x1f0000, 8), digest]));
    this.channel.write(frame);
    if (!(await this.channel.read(frame.length)).equals(frame))
      protocolError("Invalid inverter authentication acknowledgement.");
    if ((await this.query(0x1f0010, 1)).readUInt16LE(0) !== 1)
      throw new SelectLiveError(
        "auth",
        "The inverter rejected its login password; use selectlive auth --device SERIAL.",
      );
  }
}
export interface DeviceInfo {
  serial: string;
  modelCode: number;
  firmware: string;
  firmwareRaw: number;
  versions: {
    configuration: number;
    service: number;
    memoryMap: number;
    events: number;
    detailed: number;
    daily: number;
  };
}
export async function deviceInfo(reader: MemoryReader): Promise<DeviceInfo> {
  const versions = wordsFrom(await reader.query(0xa007, 6));
  const firmwareRaw = (await reader.query(0xa032, 1)).readUInt16LE(0);
  const identity = await reader.query(0xa05d, 3);
  return {
    serial: String(identity.readUInt32LE(2)),
    modelCode: identity.readUInt16LE(0),
    firmwareRaw,
    firmware: `${Math.floor(firmwareRaw / 100)}.${String(firmwareRaw % 100).padStart(2, "0")}`,
    versions: {
      configuration: versions[0],
      service: versions[1],
      memoryMap: versions[2],
      events: versions[3],
      detailed: versions[4],
      daily: versions[5],
    },
  };
}
