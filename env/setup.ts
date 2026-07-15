#!/usr/bin/env npx tsx

/**
 * Workspace setup for Conductor worktrees.
 *
 * Phases:
 * 1. Vercel project link    - ensures .vercel/project.json exists
 * 2. Dependencies           - npm install
 * 3. Vercel environment     - pulls .env.local from Vercel (development). Vercel is
 *                             the single source of truth for env vars.
 * 4. Environment validation - checks required/optional env vars
 * 5. Verification           - confirms node_modules, vercel link
 */

import fs from "fs";
import path from "path";
import {
  setupHeader,
  setupFooter,
  phaseHeader,
  success,
  error,
  warn,
  info,
} from "./lib/output";
import {
  ROOT,
  run,
  checkEnv,
  checkNodeModules,
  checkVercelLink,
} from "./lib/checks";

const TOTAL_PHASES = 5;
const VERCEL_PROJECT = "liveone";

const force = process.argv.includes("--force");

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Vercel project link
// ---------------------------------------------------------------------------

function phaseVercelLink(errors: string[]): void {
  phaseHeader(1, TOTAL_PHASES, "Vercel project link");

  const projectJson = path.join(ROOT, ".vercel", "project.json");
  if (fs.existsSync(projectJson) && !force) {
    success("Already linked to Vercel project");
    return;
  }

  if (fs.existsSync(projectJson) && force) {
    info("Force mode: re-linking Vercel project");
  }

  const { code: vercelCode } = run(["vercel", "--version"]);
  if (vercelCode !== 0) {
    warn("vercel CLI not found (install with `npm i -g vercel`) — skipping");
    return;
  }

  const { code, stdout, stderr } = run([
    "vercel",
    "link",
    "--cwd",
    ROOT,
    "--project",
    VERCEL_PROJECT,
    "--yes",
  ]);
  if (code !== 0) {
    error(`vercel link failed: ${stderr || stdout}`);
    errors.push("vercel link failed");
    return;
  }

  if (fs.existsSync(projectJson)) {
    success(`Linked to Vercel project '${VERCEL_PROJECT}'`);
  } else {
    error("vercel link completed but project.json not created");
    errors.push("vercel link did not create project.json");
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Dependencies
// ---------------------------------------------------------------------------

function phaseDependencies(errors: string[]): void {
  phaseHeader(2, TOTAL_PHASES, "Dependencies");

  const { code: npmCheck } = run(["npm", "--version"]);
  if (npmCheck !== 0) {
    error("npm not found");
    errors.push("npm not found");
    return;
  }

  const { code, stderr } = run(["npm", "install"], ROOT);
  if (code === 0) {
    success("npm install");
  } else {
    error(`npm install failed: ${stderr}`);
    errors.push("npm install failed");
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Vercel environment
// ---------------------------------------------------------------------------

function phaseVercelEnv(errors: string[]): void {
  phaseHeader(3, TOTAL_PHASES, "Vercel environment");

  const { code: vercelCode } = run(["vercel", "--version"]);
  if (vercelCode !== 0) {
    warn("vercel CLI not found — skipping env pull");
    return;
  }

  const projectJson = path.join(ROOT, ".vercel", "project.json");
  if (!fs.existsSync(projectJson)) {
    warn("Vercel project not linked — skipping env pull");
    return;
  }

  const target = path.join(ROOT, ".env.local");

  // Legacy worktrees symlink .env.local to a shared home. Remove the symlink
  // before pulling — otherwise `vercel env pull` writes THROUGH it and clobbers
  // the shared file, breaking other worktrees and destroying local-only vars
  // kept there. Unlinking only drops this worktree's pointer; the shared file
  // is left intact.
  if (isSymlink(target)) {
    fs.unlinkSync(target);
    info("Removed legacy .env.local symlink (pulling a real file instead)");
  }

  const { code, stdout, stderr } = run([
    "vercel",
    "env",
    "pull",
    "--cwd",
    ROOT,
    target,
    "--environment=development",
    "--yes",
  ]);
  if (code !== 0) {
    error(`vercel env pull failed: ${stderr || stdout}`);
    errors.push("vercel env pull failed");
    return;
  }

  success("Pulled .env.local from Vercel (development)");
  info(
    "Local-only tooling vars (TEST_USER_ID, SIGENERGY_*, PROD_CLERK_SECRET_KEY) " +
      "are not in Vercel — add them to .env.local by hand if you run integration " +
      "tests, sigen:poll, or the gusher-key mint script.",
  );
}

// ---------------------------------------------------------------------------
// Phase 4: Environment validation
// ---------------------------------------------------------------------------

function phaseEnvValidation(errors: string[]): void {
  phaseHeader(4, TOTAL_PHASES, "Environment validation");

  const { results } = checkEnv(ROOT);

  for (const r of results) {
    if (r.status === "ok") success(r.message);
    else if (r.status === "warn") warn(r.message);
    else if (r.status === "info") info(r.message);
    else {
      error(r.message);
      errors.push(r.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: Verification
// ---------------------------------------------------------------------------

function phaseVerification(errors: string[]): void {
  phaseHeader(5, TOTAL_PHASES, "Verification");

  const nodeModulesResult = checkNodeModules();
  if (nodeModulesResult.status === "ok") success(nodeModulesResult.message);
  else {
    error(nodeModulesResult.message);
    errors.push(nodeModulesResult.message);
  }

  const vercelResult = checkVercelLink();
  if (vercelResult.status === "ok") success(vercelResult.message);
  else warn(vercelResult.message);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const start = Date.now();
  const errors: string[] = [];

  setupHeader();

  phaseVercelLink(errors);
  console.log();

  phaseDependencies(errors);
  console.log();

  phaseVercelEnv(errors);
  console.log();

  phaseEnvValidation(errors);
  console.log();

  phaseVerification(errors);

  const duration = (Date.now() - start) / 1000;
  setupFooter(errors, duration);
  console.log();

  return errors.length > 0 ? 1 : 0;
}

process.exit(main());
