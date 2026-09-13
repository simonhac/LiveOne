import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each(["data", "metrics"])(
  "SIGTERM aborts a blocked %s request and releases the supervisor lock",
  async (phase) => {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-stop-"));
    const uuid = "11111111-1111-4111-8111-111111111111";
    let reached!: () => void;
    const pending = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (phase === "data" || url.pathname === "/query") {
        reached(); // Deliberately never respond; termination must cancel this request.
        return;
      }
      res.end(
        JSON.stringify({
          version: 1,
          deviceId: uuid,
          pollerId: uuid,
          revision: 1,
          start: url.searchParams.get("start"),
          end: url.searchParams.get("end"),
          asOf: url.searchParams.get("asOf"),
          values: "raw-untransformed",
          point: {
            id: uuid,
            physicalPath: "battery_soc",
            metricType: "soc",
            unit: "%",
            transform: "n",
          },
          readings: [],
          nextCursor: null,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = join(dir, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        liveoneUrl: base,
        collectorTokenEnv: "TEST_COLLECTOR",
        queryUrl: base + "/query",
        queryUsernameEnv: "TEST_USER",
        queryPasswordEnv: "TEST_PASSWORD",
        healthTokenEnv: "TEST_HEALTH",
        dataDir: dir,
        targets: [
          {
            pollerId: uuid,
            revision: 1,
            deviceId: uuid,
            readerId: uuid,
            pointId: uuid,
            vendor: "sigenergy",
            cadenceSec: 300,
            liveSessionCauses: ["CRON"],
            source: "t12345_test_metrics",
            service: "liveone",
            readCadenceSec: 300,
          },
        ],
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/gousher/production-supervisor.ts",
        config,
        "--once",
      ],
      {
        env: {
          ...process.env,
          TEST_COLLECTOR: "test",
          TEST_USER: "test",
          TEST_PASSWORD: "test",
          TEST_HEALTH: "test",
          GOUSHER_METRICS_ENDPOINT: "https://127.0.0.1:9/metrics",
          GOUSHER_METRICS_TOKEN: "test",
        },
        stdio: "pipe",
      },
    );
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      await Promise.race([
        pending,
        exit.then(() => {
          throw Error(`Supervisor exited before request: ${stderr}`);
        }),
      ]);
      child.kill("SIGTERM");
      expect(await exit).toBe(0);
      await expect(access(join(dir, "supervisor.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
  15000,
);
