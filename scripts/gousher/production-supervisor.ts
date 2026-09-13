/** Independent observer. With no policyPath it only collects baseline evidence. */
import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import {
  readFile,
  mkdir,
  open,
  rename,
  stat,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createTelemetryProvider } from "@liveone/telemetry/runtime";
import {
  observeData,
  observationTarget,
  createDataMetrics,
} from "../../lib/telemetry/data-observer";
import {
  supervisorPolicy,
  policyHash,
  evaluateHealth,
  queryReadEvidence,
  createSupervisionMetrics,
  type WindowState,
  type SupervisorTarget,
} from "../../lib/telemetry/supervisor";

const configSchema = z
  .object({
    liveoneUrl: z.string().url(),
    collectorTokenEnv: z.string().min(1),
    queryUrl: z.string().url(),
    queryUsernameEnv: z.string().min(1),
    queryPasswordEnv: z.string().min(1),
    dataDir: z.string().min(1),
    port: z.number().int().min(1024).max(65535).default(8090),
    healthTokenEnv: z.string().min(1),
    policyPath: z.string().optional(),
    // Baseline targets need no guessed thresholds. Minimum window is large enough
    // for slow cloud readers; baseline records retain actual sample counts.
    targets: z
      .array(
        observationTarget.extend({
          source: z.string().regex(/^t[0-9]+_[a-zA-Z0-9_]+_metrics$/),
          service: z.enum(["liveone", "liveone-usher"]),
          readCadenceSec: z.number().positive().max(3600),
          statWindowSec: z
            .number()
            .int()
            .min(900)
            .max(21600)
            .refine((n) => n % 900 === 0)
            .default(7200),
        }),
      )
      .min(1)
      .max(64),
  })
  .strict();
async function atomic(path: string, value: unknown) {
  const file = await open(path + ".tmp", "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path + ".tmp", path);
}
async function main() {
  const path = process.argv[2];
  if (!path) throw Error("Usage: production-supervisor.ts CONFIG [--once]");
  const config = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const secret = (name: string) => {
    const value = process.env[name];
    if (!value) throw Error(`Missing environment variable ${name}`);
    return value;
  };
  const token = secret(config.collectorTokenEnv),
    username = secret(config.queryUsernameEnv),
    password = secret(config.queryPasswordEnv),
    healthToken = secret(config.healthTokenEnv);
  const bytes = config.policyPath
    ? await readFile(config.policyPath, "utf8")
    : undefined;
  const policy = bytes ? supervisorPolicy.parse(JSON.parse(bytes)) : undefined;
  const hash = bytes ? policyHash(bytes) : "baseline-only";
  const targets = policy?.targets ?? config.targets;
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // Exclusive ownership is intentionally retained after crashes; inspect before removing.
  const lockPath = join(config.dataDir, "supervisor.lock");
  const lock = await open(lockPath, "wx", 0o600);
  const statePath = join(config.dataDir, "windows.json");
  let states: Record<string, WindowState> = {};
  try {
    const saved = z
      .object({
        policyId: z.string(),
        states: z.record(
          z.string(),
          z.object({
            end: z.number().finite(),
            consecutive: z.number().int().nonnegative(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(statePath, "utf8")));
    if (saved.policyId === hash) states = saved.states;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error("Invalid supervisor state; investigate before restarting");
  }
  const provider = createTelemetryProvider(
    "liveone-trial-supervisor",
    process.env.GOUSHER_METRICS_ENDPOINT,
    process.env.GOUSHER_METRICS_TOKEN,
    true,
  );
  if (!provider)
    throw Error("Independent supervisor telemetry destination required");
  const meter = provider.getMeter("liveone/supervision");
  const recordData = createDataMetrics(meter, "production"),
    recordHealth = createSupervisionMetrics(meter);
  const evidence = new Map<
    string,
    {
      pollerId: string;
      revision: number;
      policyId: string;
      observedAt: string;
      healthy: boolean;
    }
  >();
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    if (
      !timingSafeEqual(
        digest(req.headers.authorization ?? ""),
        digest(`Bearer ${healthToken}`),
      )
    ) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const item = evidence.get((req.url ?? "").replace(/^\/health\//, ""));
    if (!policy || !item) {
      res.writeHead(503).end(JSON.stringify({ error: "evidence unavailable" }));
      return;
    }
    res.end(JSON.stringify(item)); // Never replace observation time with request time.
  });
  if (!process.argv.includes("--once"))
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", resolve);
    });
  const shutdown = new AbortController();
  let stopped = false;
  const stop = () => {
    stopped = true;
    shutdown.abort();
    server.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    do {
      const observations: unknown[] = [];
      const grouped = new Map<
        string,
        { revision: number; healthy: boolean; at: number }
      >();
      let observationFailed = false;
      for (const target of targets) {
        if (stopped) break;
        const prior = grouped.get(target.pollerId) ?? {
          revision: target.revision,
          healthy: true,
          at: Infinity,
        };
        let data: Awaited<ReturnType<typeof observeData>> | undefined;
        let phase = "data";
        try {
          const asOf = Date.now();
          data = await observeData(
            config.liveoneUrl,
            token,
            target,
            asOf,
            120,
            fetch,
            shutdown.signal,
          );
          recordData(target, data);
          phase = "metrics";
          const read = await queryReadEvidence(
            config.queryUrl,
            username,
            password,
            target as SupervisorTarget,
            asOf,
            fetch,
            shutdown.signal,
          );
          observations.push({ target, data, read });
          if (policy) {
            const key = `${target.pollerId}/${target.pointId}`;
            const result = evaluateHealth(
              target as SupervisorTarget,
              data,
              read,
              states[key],
              Date.now() / 1000,
            );
            states[key] = result.state;
            prior.healthy &&= result.healthy;
            prior.at = Math.min(prior.at, result.observedAt);
          } else prior.healthy = false;
        } catch {
          observationFailed = true;
          prior.healthy = false;
          prior.at = 0;
          observations.push({
            target,
            data,
            error: `${phase}-observation-failed`,
          });
        }
        grouped.set(target.pollerId, prior);
      }
      if (stopped) break;
      if (process.argv.includes("--once") && observationFailed)
        process.exitCode = 1;
      // Persist window decisions before exposing health. A failed write leaves old
      // evidence to expire and must terminate this producer.
      await atomic(statePath, { policyId: hash, states });
      const day = new Date().toISOString().slice(0, 10);
      const journal = join(config.dataDir, `${day}.jsonl`);
      const files = (await readdir(config.dataDir))
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .sort();
      for (const old of files.slice(0, Math.max(0, files.length - 44)))
        await unlink(join(config.dataDir, old));
      let total = 0;
      for (const name of files.slice(-44))
        total += (await stat(join(config.dataDir, name))).size;
      const line =
        JSON.stringify({
          at: new Date().toISOString(),
          policyId: hash,
          observations,
        }) + "\n";
      if (total + Buffer.byteLength(line) > 64 * 1024 * 1024)
        throw Error("Baseline journal budget exhausted; archive evidence");
      const file = await open(journal, "a", 0o600);
      try {
        await file.writeFile(line);
      } finally {
        await file.close();
      }
      for (const [poller, s] of grouped) {
        const at = Number.isFinite(s.at) ? s.at : 0;
        recordHealth(poller, s.revision, hash, s.healthy, at);
        evidence.set(poller, {
          pollerId: poller,
          revision: s.revision,
          policyId: hash,
          observedAt: new Date(at * 1000).toISOString(),
          healthy: s.healthy,
        });
      }
      if (process.argv.includes("--once")) break;
      for (let elapsed = 0; elapsed < 30000 && !stopped; elapsed += 250)
        await new Promise((r) => setTimeout(r, 250));
    } while (!stopped);
  } finally {
    server.close();
    try {
      await provider.shutdown();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}
main().catch(() => {
  console.error(
    "Production supervisor failed; inspect configuration, credentials and private state. Trial supervision is unavailable.",
  );
  process.exitCode = 1;
});
