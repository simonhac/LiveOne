#!/usr/bin/env npx tsx

/**
 * Workspace setup for Conductor worktrees.
 *
 * Phases:
 * 1. Vercel project link    - ensures .vercel/project.json exists
 * 2. Shared dev resources   - symlinks .env.local and dev.db from $LIVEONE_SHARED_HOME
 *                             (default: ~/dev/liveone). Skipped if dir doesn't exist.
 * 3. Dependencies           - npm install
 * 4. Vercel environment     - pulls .env.development.local. Skipped when shared
 *                             .env.local is in use (would be shadowed by it anyway).
 * 5. Environment validation - checks required/optional env vars
 * 6. Verification           - confirms node_modules, vercel link, dev.db
 */

import fs from "fs";
import os from "os";
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
  checkDevDb,
} from "./lib/checks";

const TOTAL_PHASES = 6;
const VERCEL_PROJECT = "liveone";
const SHARED_HOME =
  process.env.LIVEONE_SHARED_HOME ?? path.join(os.homedir(), "dev", "liveone");
const SHARED_FILES = [".env.local", "dev.db"];

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
// Phase 2: Shared dev resources
// ---------------------------------------------------------------------------

function phaseSharedResources(errors: string[]): void {
  phaseHeader(2, TOTAL_PHASES, "Shared dev resources");

  if (!fs.existsSync(SHARED_HOME)) {
    info(`No shared home at ${SHARED_HOME} (skipping)`);
    return;
  }

  info(`Shared home: ${SHARED_HOME}`);

  for (const name of SHARED_FILES) {
    const source = path.join(SHARED_HOME, name);
    const target = path.join(ROOT, name);

    if (!fs.existsSync(source)) {
      info(`${name} not in shared home (skipping)`);
      continue;
    }

    const targetExists = fs.existsSync(target) || isSymlink(target);
    const targetIsSymlink = isSymlink(target);

    if (targetExists && !force) {
      if (targetIsSymlink) {
        const real = fs.realpathSync(target);
        success(`${name} already linked: ${real}`);
      } else {
        warn(
          `${name} exists as a real file (keeping it; use --force to replace)`,
        );
      }
      continue;
    }

    if (targetExists && force) {
      if (targetIsSymlink) {
        info(`Force mode: removing existing ${name} symlink`);
        fs.unlinkSync(target);
      } else {
        warn(`Force mode: ${name} is a real file, not a symlink (keeping it)`);
        continue;
      }
    }

    try {
      fs.symlinkSync(source, target);
      success(`Linked ${name} -> ${source}`);
    } catch (e) {
      error(`Failed to symlink ${name}: ${e}`);
      errors.push(`Failed to symlink ${name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Dependencies
// ---------------------------------------------------------------------------

function phaseDependencies(errors: string[]): void {
  phaseHeader(3, TOTAL_PHASES, "Dependencies");

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
// Phase 4: Vercel environment
// ---------------------------------------------------------------------------

function phaseVercelEnv(errors: string[]): void {
  phaseHeader(4, TOTAL_PHASES, "Vercel environment");

  if (isSymlink(path.join(ROOT, ".env.local"))) {
    info(
      "Skipped — shared .env.local in use (would shadow .env.development.local)",
    );
    return;
  }

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

  const target = path.join(ROOT, ".env.development.local");
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
  } else {
    success("Pulled .env.development.local from Vercel");
  }
}

// ---------------------------------------------------------------------------
// Phase 5: Environment validation
// ---------------------------------------------------------------------------

function phaseEnvValidation(errors: string[]): void {
  phaseHeader(5, TOTAL_PHASES, "Environment validation");

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
// Phase 6: Verification
// ---------------------------------------------------------------------------

function phaseVerification(errors: string[]): void {
  phaseHeader(6, TOTAL_PHASES, "Verification");

  const nodeModulesResult = checkNodeModules();
  if (nodeModulesResult.status === "ok") success(nodeModulesResult.message);
  else {
    error(nodeModulesResult.message);
    errors.push(nodeModulesResult.message);
  }

  const vercelResult = checkVercelLink();
  if (vercelResult.status === "ok") success(vercelResult.message);
  else warn(vercelResult.message);

  const devDbResult = checkDevDb();
  if (devDbResult.status === "ok") success(devDbResult.message);
  else {
    error(devDbResult.message);
    errors.push(devDbResult.message);
  }
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

  phaseSharedResources(errors);
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
