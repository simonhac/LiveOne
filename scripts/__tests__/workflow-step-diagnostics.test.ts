import { describe, expect, it } from "@jest/globals";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyWorkflowFailure,
  countRecoveredConnectionDropouts,
  runWorkflowStep,
} from "../utils/run-workflow-step-with-diagnostics";

describe("sync workflow failure diagnostics", () => {
  it.each([
    ["Error: read ECONNRESET", "ECONNRESET"],
    [
      "Error: Connection terminated unexpectedly",
      "Connection terminated unexpectedly",
    ],
    ["socket hang up", "socket hang up"],
  ])(
    "classifies connection dropouts without copying arbitrary logs",
    (log, detail) => {
      expect(classifyWorkflowFailure(log)).toEqual({
        mode: "database connection dropout",
        detail,
      });
    },
  );

  it.each([
    ["prod/dev schema mismatch", "database schema mismatch"],
    [
      "duplicate key value violates unique constraint",
      "database constraint violation",
    ],
    [
      "password authentication failed for user",
      "database authentication/authorization failure",
    ],
    ["refusing to run: target is prod", "safety refusal"],
    ["operation timed out", "operation timeout"],
  ])("classifies deterministic failures: %s", (log, mode) => {
    expect(classifyWorkflowFailure(log).mode).toBe(mode);
  });

  it("uses a safe fallback for unknown output", () => {
    expect(classifyWorkflowFailure("secret-looking arbitrary output")).toEqual({
      mode: "unclassified command failure",
      detail: "inspect the linked Actions log",
    });
  });

  it("counts retry events rather than duplicate client error lines", () => {
    expect(
      countRecoveredConnectionDropouts(
        "[sync] connection error: Connection terminated unexpectedly\n" +
          "[sync] transient connection failure; restarting the idempotent sync (attempt 2/3)\n" +
          "[sync] connection error: Connection terminated unexpectedly\n" +
          "[sync] transient connection failure; restarting the idempotent sync (attempt 3/3)\n",
      ),
    ).toBe(2);
  });

  it("exports recovered dropout counts for successful-run monitoring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-diagnostics-"));
    const envFile = join(dir, "github-env");
    const previousEnvFile = process.env.GITHUB_ENV;
    process.env.GITHUB_ENV = envFile;
    try {
      const code = await runWorkflowStep("prod→dev DB sync", process.execPath, [
        "-e",
        'console.log("[sync] transient connection failure; restarting the idempotent sync (attempt 2/3)");',
      ]);
      expect(code).toBe(0);
      expect(readFileSync(envFile, "utf8")).toBe(
        "SYNC_CONNECTION_DROPOUT_COUNT=1\n" +
          "SYNC_CONNECTION_DROPOUT_STAGES=prod→dev DB sync (1)\n",
      );
    } finally {
      if (previousEnvFile === undefined) delete process.env.GITHUB_ENV;
      else process.env.GITHUB_ENV = previousEnvFile;
      rmSync(dir, { recursive: true });
    }
  });

  it("exports sanitized diagnostics for the Slack alert step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-diagnostics-"));
    const envFile = join(dir, "github-env");
    const previousEnvFile = process.env.GITHUB_ENV;
    process.env.GITHUB_ENV = envFile;
    try {
      const code = await runWorkflowStep("prod→dev DB sync", process.execPath, [
        "-e",
        'console.error("Error: Connection terminated unexpectedly"); process.exit(7)',
      ]);
      expect(code).toBe(7);
      expect(readFileSync(envFile, "utf8")).toBe(
        "SYNC_FAILURE_STAGE=prod→dev DB sync\n" +
          "SYNC_FAILURE_MODE=database connection dropout\n" +
          "SYNC_FAILURE_DETAIL=Connection terminated unexpectedly; 3-attempt retry budget exhausted\n",
      );
    } finally {
      if (previousEnvFile === undefined) delete process.env.GITHUB_ENV;
      else process.env.GITHUB_ENV = previousEnvFile;
      rmSync(dir, { recursive: true });
    }
  });
});
