/** Deliberately bounded messages: never include server payloads or credentials. */
export class SelectLiveError extends Error {
  constructor(
    readonly kind:
      | "usage"
      | "auth"
      | "offline"
      | "busy"
      | "protocol"
      | "network"
      | "interrupted",
    message: string,
  ) {
    super(message);
    this.name = "SelectLiveError";
  }
}
export function protocolError(message: string): never {
  throw new SelectLiveError("protocol", message);
}
