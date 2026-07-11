/**
 * Collector core — the gusher push client (the shared "Sink").
 *
 * POSTs self-describing readings to `/api/gush` with auth (siteId + apiKey) and retry/backoff on
 * transient failures. Abstracted so an alternative sink (e.g. MqttSink) can drop in later without
 * touching the sources. A successful store also updates the system's polling_status on the server,
 * so LiveOne's existing freshness alerting doubles as the heartbeat.
 */

import type { GushRequestBody, PushReading } from "@liveone/protocol";

export interface PusherOptions {
  /** full URL to the gusher receiver, e.g. https://…/api/gush */
  endpoint: string;
  siteId: string;
  apiKey: string;
  maxRetries?: number;
  log?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Pusher {
  private readonly maxRetries: number;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: PusherOptions) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.log = opts.log ?? (() => {});
  }

  /** Validate auth without storing (action=test). */
  async test(): Promise<boolean> {
    const res = await this.post({
      vendorSiteId: this.opts.siteId,
      apiKey: this.opts.apiKey,
      action: "test",
    });
    if (!res.ok) this.log(`auth test failed (${res.status}): ${res.text}`);
    return res.ok;
  }

  /** Store a batch of readings (action=store), retrying transient (network/5xx/429) failures. */
  async store(
    readings: PushReading[],
    meta: { sessionLabel: string; measurementTime: string },
  ): Promise<boolean> {
    const body: GushRequestBody = {
      vendorSiteId: this.opts.siteId,
      apiKey: this.opts.apiKey,
      action: "store",
      sessionLabel: meta.sessionLabel,
      measurementTime: meta.measurementTime,
      readings,
    };
    for (let attempt = 0; ; attempt++) {
      const res = await this.post(body);
      if (res.ok) {
        this.log(`stored ${readings.length} readings (${res.status})`);
        return true;
      }
      // permanent client errors (bad key/site/body) — don't retry
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        this.log(`push rejected ${res.status}: ${res.text}`);
        return false;
      }
      if (attempt >= this.maxRetries) {
        this.log(
          `push failed after ${attempt} retries (${res.status}): ${res.text}`,
        );
        return false;
      }
      const backoff = Math.min(2000 * 2 ** attempt, 15000);
      this.log(`push ${res.status || "network error"}, retry in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  private async post(
    body: GushRequestBody,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    try {
      const res = await fetch(this.opts.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text().catch(() => "");
      return { ok: res.ok, status: res.status, text: text.slice(0, 300) };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        text: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
