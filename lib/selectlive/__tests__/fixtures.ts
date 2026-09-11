import { Duplex } from "node:stream";
import { Channel } from "../transport";
export function simulated(
  handler: (data: Buffer, socket: Duplex) => void,
  timeout = 1000,
) {
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      handler(Buffer.from(chunk), this);
      callback();
    },
  });
  return { socket, channel: new Channel(socket, timeout) };
}
