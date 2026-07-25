#!/usr/bin/env tsx
/**
 * Run one sync-workflow command, preserving its live output while recording a
 * sanitized failure classification for the later Slack alert step.
 */
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

export interface FailureDiagnostic {
  mode: string;
  detail: string;
}

const connectionSignatures: Array<[RegExp, string]> = [
  [/\bECONNRESET\b/i, "ECONNRESET"],
  [/\bEPIPE\b/i, "EPIPE"],
  [/\bETIMEDOUT\b/i, "ETIMEDOUT"],
  [/connection terminated unexpectedly/i, "Connection terminated unexpectedly"],
  [
    /client has encountered a connection error/i,
    "Postgres client connection error",
  ],
  [/socket hang up/i, "socket hang up"],
  [/broken pipe/i, "broken pipe"],
];

export function classifyWorkflowFailure(output: string): FailureDiagnostic {
  for (const [pattern, detail] of connectionSignatures) {
    if (pattern.test(output)) {
      return { mode: "database connection dropout", detail };
    }
  }
  if (/prod\/dev schema mismatch|schema mismatch/i.test(output)) {
    return {
      mode: "database schema mismatch",
      detail: "schema preflight failed",
    };
  }
  if (
    /duplicate key value|violates (?:unique|foreign key|check|not-null) constraint/i.test(
      output,
    )
  ) {
    return {
      mode: "database constraint violation",
      detail: "data reconciliation failed",
    };
  }
  if (
    /password authentication failed|authentication failed|permission denied/i.test(
      output,
    )
  ) {
    return {
      mode: "database authentication/authorization failure",
      detail: "credentials or grants rejected",
    };
  }
  if (/refusing to run|refusing to use the production database/i.test(output)) {
    return {
      mode: "safety refusal",
      detail: "database target guard rejected the command",
    };
  }
  if (/timed? ?out|timeout/i.test(output)) {
    return { mode: "operation timeout", detail: "command exceeded a timeout" };
  }
  return {
    mode: "unclassified command failure",
    detail: "inspect the linked Actions log",
  };
}

export function countRecoveredConnectionDropouts(output: string): number {
  return (
    output.match(
      /transient connection failure; (?:restarting|retrying)(?: the idempotent sync)?/gi,
    )?.length ?? 0
  );
}

function writeGithubEnv(name: string, value: string): void {
  const envFile = process.env.GITHUB_ENV;
  if (!envFile) return;
  // Classifications are controlled single-line strings, but normalize anyway so
  // they cannot inject an additional Actions environment entry.
  appendFileSync(envFile, `${name}=${value.replace(/[\r\n]+/g, " ")}\n`);
}

export async function runWorkflowStep(
  stage: string,
  command: string,
  args: string[],
): Promise<number> {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  let output = "";
  const remember = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-128_000);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    remember(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    remember(chunk);
  });

  const result = await new Promise<{
    code: number;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  if (result.code === 0) {
    const recoveredDropouts = countRecoveredConnectionDropouts(output);
    if (recoveredDropouts > 0) {
      const previousCount = Number(
        process.env.SYNC_CONNECTION_DROPOUT_COUNT ?? 0,
      );
      const previousStages = process.env.SYNC_CONNECTION_DROPOUT_STAGES;
      writeGithubEnv(
        "SYNC_CONNECTION_DROPOUT_COUNT",
        String(previousCount + recoveredDropouts),
      );
      writeGithubEnv(
        "SYNC_CONNECTION_DROPOUT_STAGES",
        [previousStages, `${stage} (${recoveredDropouts})`]
          .filter(Boolean)
          .join(", "),
      );
    }
    return 0;
  }

  const diagnostic = classifyWorkflowFailure(output);
  let detail = result.signal
    ? `${diagnostic.detail}; signal ${result.signal}`
    : diagnostic.detail;
  if (
    diagnostic.mode === "database connection dropout" &&
    (stage === "prod→dev DB sync" || stage === "run-period recompute")
  ) {
    detail += "; 3-attempt retry budget exhausted";
  }
  writeGithubEnv("SYNC_FAILURE_STAGE", stage);
  writeGithubEnv("SYNC_FAILURE_MODE", diagnostic.mode);
  writeGithubEnv("SYNC_FAILURE_DETAIL", detail);
  console.error(
    `::error title=${stage} failed::${diagnostic.mode} — ${detail}`,
  );
  return result.code;
}

async function main(): Promise<void> {
  const [, , stage, command, ...args] = process.argv;
  if (!stage || !command) {
    throw new Error(
      "usage: run-workflow-step-with-diagnostics.ts <stage> <command> [args...]",
    );
  }
  process.exitCode = await runWorkflowStep(stage, command, args);
}

if (require.main === module) {
  void main().catch((error) => {
    writeGithubEnv("SYNC_FAILURE_STAGE", process.argv[2] ?? "workflow command");
    writeGithubEnv("SYNC_FAILURE_MODE", "diagnostic wrapper failure");
    writeGithubEnv("SYNC_FAILURE_DETAIL", "inspect the linked Actions log");
    console.error(error);
    process.exitCode = 1;
  });
}
