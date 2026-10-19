/**
 * EV-overnight advisor — the outbound seam. Only a mock exists: the investigation does not choose a
 * transport (SMS, push, Slack). Whatever is chosen implements `TextSender`.
 */

export interface TextMessage {
  to: string;
  body: string;
  meta?: Record<string, unknown>;
}

/**
 * @knipignore The transport seam: the investigation only has the mock; a real sender implements this.
 */
export interface TextSender {
  send(msg: TextMessage): Promise<{ id: string }>;
}

export interface SentText extends TextMessage {
  id: string;
  sentAtMs: number;
}

/** Records every message; optionally writes each as one JSON line to `sink` (e.g. an outbox file). */
export class MockTextSender implements TextSender {
  readonly sent: SentText[] = [];

  constructor(
    private readonly sink?: (line: string) => void,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async send(msg: TextMessage): Promise<{ id: string }> {
    const sent: SentText = {
      ...msg,
      id: `mock-${this.sent.length + 1}`,
      sentAtMs: this.clock(),
    };
    this.sent.push(sent);
    this.sink?.(JSON.stringify(sent));
    return { id: sent.id };
  }
}
