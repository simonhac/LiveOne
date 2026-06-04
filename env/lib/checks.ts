/**
 * Shared verification functions for setup and run scripts.
 */

import { execSync } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnvFileEntries } from "./origin-tracer";
import { validateEnvironment, formatValidationReport } from "./validate";
import type { ValidationResult } from "./types";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// Check result types
// ---------------------------------------------------------------------------

export type CheckStatus = "ok" | "info" | "warn" | "fail";

export interface CheckResult {
  status: CheckStatus;
  message: string;
}

// ---------------------------------------------------------------------------
// Subprocess utility
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string[], cwd?: string): RunResult {
  try {
    const stdout = execSync(cmd.join(" "), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return { code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: e.status ?? 1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? "").trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// Git worktree utility
// ---------------------------------------------------------------------------

export function getMainWorktree(): string | null {
  const { code, stdout } = run(
    ["git", "worktree", "list", "--porcelain"],
    ROOT,
  );
  if (code !== 0) return null;

  let mainPath: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      mainPath = line.slice("worktree ".length);
      break;
    }
  }

  if (mainPath === null) return null;
  if (path.resolve(mainPath) === path.resolve(ROOT)) return null;

  return mainPath;
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Find the first free port starting at `start`, scanning up to `range` ports.
 * Returns null if none free.
 */
export async function findFreePort(
  start: number,
  range: number = 20,
): Promise<number | null> {
  for (let port = start; port < start + range; port++) {
    if (await isPortFree(port)) return port;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

/**
 * Load .env files into process.env so validateEnvironment() can find them.
 * Next.js does this automatically; tsx does not. Also ensures NODE_ENV is
 * set to "development" since these scripts only run locally.
 */
function populateProcessEnv(rootDir: string): void {
  const env = process.env as Record<string, string | undefined>;
  if (!env.NODE_ENV) {
    env.NODE_ENV = "development";
  }
  const entries = loadEnvFileEntries(rootDir);
  for (const [name, entry] of entries) {
    if (env[name] === undefined) {
      env[name] = entry.value;
    }
  }
}

export interface EnvCheckResult {
  results: CheckResult[];
  validationResult: ValidationResult;
  report: string;
}

export function checkEnv(rootDir: string): EnvCheckResult {
  populateProcessEnv(rootDir);
  const validationResult = validateEnvironment(rootDir);
  const report = formatValidationReport(validationResult, rootDir);

  const results: CheckResult[] = [];

  if (validationResult.valid) {
    const count = validationResult.vars.filter((v) => v.required).length;
    results.push({
      status: "ok",
      message: `All ${count} required env vars present`,
    });
  } else {
    for (const err of validationResult.errors) {
      results.push({ status: "fail", message: err });
    }
  }

  for (const w of validationResult.warnings) {
    results.push({ status: "warn", message: w });
  }

  return { results, validationResult, report };
}

// ---------------------------------------------------------------------------
// Node modules check
// ---------------------------------------------------------------------------

export function checkNodeModules(): CheckResult {
  const nodeModules = path.join(ROOT, "node_modules");
  if (fs.existsSync(nodeModules)) {
    return { status: "ok", message: "node_modules exists" };
  }
  return {
    status: "fail",
    message: "node_modules missing — run npm install",
  };
}

// ---------------------------------------------------------------------------
// Vercel link check
// ---------------------------------------------------------------------------

export function checkVercelLink(): CheckResult {
  const projectJson = path.join(ROOT, ".vercel", "project.json");
  if (fs.existsSync(projectJson)) {
    return { status: "ok", message: ".vercel/project.json exists" };
  }
  return {
    status: "warn",
    message: ".vercel/project.json missing (run ./env/setup.ts to link)",
  };
}

// ---------------------------------------------------------------------------
// Dev DB check
// ---------------------------------------------------------------------------

export function checkDevDb(): CheckResult {
  const devDb = path.join(ROOT, "dev.db");
  if (fs.existsSync(devDb)) {
    if (isSymlink(devDb)) {
      const realPath = fs.realpathSync(devDb);
      return { status: "ok", message: `dev.db -> ${realPath}` };
    }
    return { status: "ok", message: "dev.db exists" };
  }
  return {
    status: "fail",
    message: "dev.db missing — run npm run db:push or npm run db:sync-prod",
  };
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------

export interface AllChecksResult {
  results: CheckResult[];
  envReport: string;
  hasFails: boolean;
}

export function runAllChecks(): AllChecksResult {
  const allResults: CheckResult[] = [];

  const envCheck = checkEnv(ROOT);
  allResults.push(...envCheck.results);

  allResults.push(checkNodeModules());
  allResults.push(checkVercelLink());
  allResults.push(checkDevDb());

  const hasFails = allResults.some((r) => r.status === "fail");

  return { results: allResults, envReport: envCheck.report, hasFails };
}
