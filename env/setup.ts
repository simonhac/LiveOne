#!/usr/bin/env npx tsx

/**
 * Workspace setup for Conductor worktrees.
 *
 * Phases:
 * 1. Vercel project link    - ensures .vercel/project.json exists (for `vercel` deploys)
 * 2. Dependencies           - npm install
 * 3. 1Password environment  - `op inject`s .env.local from the committed .env.tpl
 *                             (op:// references into the liveone-dev vault). 1Password
 *                             is the single source of truth for env vars; Vercel/Fly are
 *                             sync targets, managed by the infra repo (config/liveone.json).
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
// Phase 3: 1Password environment
// ---------------------------------------------------------------------------

function phaseOnePasswordEnv(errors: string[]): void {
  phaseHeader(3, TOTAL_PHASES, "1Password environment");

  const tpl = path.join(ROOT, ".env.tpl");
  if (!fs.existsSync(tpl)) {
    warn(".env.tpl not found — skipping env bootstrap");
    return;
  }

  const { code: opCode } = run(["op", "--version"]);
  if (opCode !== 0) {
    warn(
      "1Password CLI (op) not found — skipping env bootstrap. Install it " +
        "(https://developer.1password.com/docs/cli) then re-run, or create " +
        ".env.local by hand.",
    );
    return;
  }

  // op inject needs an authenticated session — a personal `op signin`, or an
  // OP_SERVICE_ACCOUNT_TOKEN scoped to the liveone-dev vault, both work.
  const { code: authCode } = run(["op", "whoami"]);
  if (authCode !== 0) {
    error(
      "1Password CLI not signed in — run `op signin` (or set " +
        "OP_SERVICE_ACCOUNT_TOKEN scoped to liveone-dev), then re-run setup.",
    );
    errors.push("op not authenticated");
    return;
  }

  const target = path.join(ROOT, ".env.local");

  // Legacy worktrees symlink .env.local to a shared home. Remove the symlink
  // before writing — otherwise `op inject -o` writes THROUGH it and clobbers
  // the shared file, breaking other worktrees and destroying local-only vars
  // kept there. Unlinking only drops this worktree's pointer; the shared file
  // is left intact.
  if (isSymlink(target)) {
    fs.unlinkSync(target);
    info("Removed legacy .env.local symlink (writing a real file instead)");
  }

  // Resolve the op:// references in .env.tpl against the vault into a concrete
  // .env.local. --force overwrites any existing file (execSync is non-interactive,
  // so we can't answer an overwrite prompt).
  const { code, stdout, stderr } = run([
    "op",
    "inject",
    "-i",
    tpl,
    "-o",
    target,
    "--force",
  ]);
  if (code !== 0) {
    error(`op inject failed: ${stderr || stdout}`);
    errors.push("op inject failed");
    return;
  }

  success("Wrote .env.local from .env.tpl (1Password, liveone-dev vault)");
  info(
    "Tooling vars absent from 1Password (e.g. SIGENERGY_*, PROD_CLERK_SECRET_KEY) " +
      "must be added to .env.local by hand if you run sigen:poll or the prod-Clerk " +
      "test helpers. Uncomment local knobs (CRONS_ENABLED, DB_SSL, ALLOW_PROD_DB_IN_DEV) " +
      "in .env.tpl as needed.",
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

  phaseOnePasswordEnv(errors);
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
