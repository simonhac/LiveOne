#!/usr/bin/env npx tsx

/**
 * Start the dev server with pre-flight checks.
 * Auto-picks a free port if 3000 is in use (Conductor-friendly).
 */

import { execSync } from "child_process";
import {
  preflightHeader,
  preflightFailed,
  success,
  error,
  warn,
  info,
} from "./lib/output";
import { ROOT, runAllChecks, findFreePort } from "./lib/checks";

const DEFAULT_PORT = 3000;

function preflight(): boolean {
  preflightHeader();

  const { results, hasFails } = runAllChecks();

  for (const r of results) {
    if (r.status === "ok") success(r.message);
    else if (r.status === "info") info(r.message);
    else if (r.status === "warn") warn(r.message);
    else error(r.message);
  }

  console.log();
  return !hasFails;
}

async function pickPort(): Promise<number> {
  const port = await findFreePort(DEFAULT_PORT);
  if (port === null) {
    error(`No free port found in range ${DEFAULT_PORT}-${DEFAULT_PORT + 19}`);
    process.exit(1);
  }
  if (port !== DEFAULT_PORT) {
    info(`Using port ${port} (${DEFAULT_PORT} was busy)`);
    console.log();
  }
  return port;
}

async function main(): Promise<void> {
  const passed = preflight();

  if (!passed) {
    preflightFailed();
    process.exit(1);
  }

  const port = await pickPort();

  console.log("Starting dev server...\n");

  try {
    execSync("npm run dev", {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, PORT: String(port) },
    });
  } catch {
    // Ctrl+C or non-zero exit — exit quietly
  }
}

main();
