/**
 * Which environment `lib/qstash.ts` thinks it is in — and specifically, that a Vercel PREVIEW is
 * not production.
 *
 * 🛑 This is a regression test with a live blast radius, not a tidiness one. Every value here is a
 * HANDLE ON SHARED INFRASTRUCTURE: dev, preview and prod share one QStash account and one
 * `OBSERVATIONS_QSTASH_TOKEN` (it is set in all three Vercel scopes), so "which prefix" and "which
 * receiver URL" decide whose queue a deployment drives and whose database its messages land in.
 *
 * The trap is that a Vercel preview build runs with `NODE_ENV=production` — it IS a production
 * build of Next.js — while `VERCEL_ENV=preview`. Keying off `NODE_ENV`, as this module did until
 * 2026-09-10, therefore handed every preview deployment prod's `obs:` flow prefix, prod's queue
 * name, and prod's receiver URL. Two consequences, both real:
 *
 *   • after the flow-control cutover, `liveone queue pause --base-url=<preview>` would pause
 *     PROD's ingest lane, and
 *   • a preview that published anything would deliver it into the PRODUCTION serving store.
 *
 * `lib/env.ts` is the one discriminator that knows preview is not production, and these tests exist
 * so that stays true. See docs/incidents/2026-09-09-observations-queue-head-of-line-stall.md.
 */
import { describe, it, expect, afterEach } from "@jest/globals";

/** Load `lib/qstash` fresh under a given environment. Its constants bind at module load. */
async function loadUnder(env: {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
}): Promise<typeof import("@/lib/qstash")> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let mod!: typeof import("@/lib/qstash");
  await jest.isolateModulesAsync(async () => {
    mod = await import("@/lib/qstash");
  });
  return mod;
}

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
  OBSERVATIONS_QSTASH_RECEIVER_URL:
    process.env.OBSERVATIONS_QSTASH_RECEIVER_URL,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.resetModules();
});

describe("a Vercel preview is not production", () => {
  /** Exactly what Vercel sets on a preview deployment, and no receiver override (it has none). */
  const PREVIEW = { NODE_ENV: "production", VERCEL_ENV: "preview" };

  const bare = async (env: Record<string, string>) => {
    delete process.env.OBSERVATIONS_QSTASH_RECEIVER_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    return loadUnder(env);
  };

  it("does not give a preview prod's flow-control prefix", async () => {
    // The control-plane handle. Same prefix = same keys = a preview's pause hits prod's lane.
    const q = await bare(PREVIEW);
    expect(q.OBSERVATIONS_FLOW_PREFIX).toBe("obs-dev");
    expect(q.observationsFlowKey("live")).toBe("obs-dev:live");
  });

  it("does not give a preview prod's queue name", async () => {
    const q = await bare(PREVIEW);
    expect(q.OBSERVATIONS_QUEUE_NAME).toBe("observations-dev");
  });

  it("does not point a preview at the production receiver", async () => {
    // The data handle. This is the one that would have written preview readings into prod.
    const q = await bare(PREVIEW);
    expect(q.getObservationsReceiverUrl()).not.toContain(
      "www.liveone.energy/api/observations/receive",
    );
  });

  it("keeps the prefixes disjoint under PREFIX matching, not merely different", async () => {
    // 🛑 `"obs:dev:live".startsWith("obs:")` is true — a middle-segment split would sweep dev keys
    // into a prod view. The environment must live in the prefix itself.
    const prod = await bare({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
    });
    const preview = await bare(PREVIEW);
    expect(
      preview.OBSERVATIONS_FLOW_PREFIX.startsWith(
        prod.OBSERVATIONS_FLOW_PREFIX + ":",
      ),
    ).toBe(false);
    expect(
      preview
        .observationsFlowKey("live")
        .startsWith(prod.OBSERVATIONS_FLOW_PREFIX + ":"),
    ).toBe(false);
  });
});

describe("production still resolves to production", () => {
  it("uses the prod prefix, queue and receiver when VERCEL_ENV says production", async () => {
    // The other half of the guard: the fix must not have quietly demoted prod to dev.
    delete process.env.OBSERVATIONS_QSTASH_RECEIVER_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const q = await loadUnder({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
    });
    expect(q.OBSERVATIONS_FLOW_PREFIX).toBe("obs");
    expect(q.OBSERVATIONS_QUEUE_NAME).toBe("observations");
    expect(q.observationsFlowKey("backfill")).toBe("obs:backfill");
    expect(q.getObservationsReceiverUrl()).toBe(
      "https://www.liveone.energy/api/observations/receive",
    );
  });

  it("parses its own keys back to a lane, and refuses the other environment's", async () => {
    const q = await loadUnder({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
    });
    expect(q.parseObservationsFlowKey("obs:backfill")).toBe("backfill");
    // A dev key must never read as ours in a prod view — the point of the disjointness rule.
    expect(q.parseObservationsFlowKey("obs-dev:backfill")).toBeNull();
  });
});

describe("local development", () => {
  it("resolves to the dev prefix and queue", async () => {
    const q = await loadUnder({
      NODE_ENV: "development",
      VERCEL_ENV: undefined,
    });
    expect(q.OBSERVATIONS_FLOW_PREFIX).toBe("obs-dev");
    expect(q.OBSERVATIONS_QUEUE_NAME).toBe("observations-dev");
  });
});
