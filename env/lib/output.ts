/**
 * ANSI color output helpers for setup and run scripts.
 */

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const BRIGHT_RED = "\x1b[1;91m";
const BRIGHT_YELLOW = "\x1b[1;93m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";

export function success(msg: string): void {
  console.log(`      ${GREEN}✓${RESET} ${msg}`);
}

// Problem lines colour the WHOLE message (bold bright red / yellow), not just the
// glyph, so they're impossible to miss in an otherwise-green setup log.
export function error(msg: string): void {
  console.log(`      ${BRIGHT_RED}✗ ${msg}${RESET}`);
}

export function warn(msg: string): void {
  console.log(`      ${BRIGHT_YELLOW}! ${msg}${RESET}`);
}

export function info(msg: string): void {
  console.log(`      ${BLUE}ℹ${RESET} ${msg}`);
}

export function phaseHeader(number: number, total: number, name: string): void {
  console.log(`${CYAN}[${number}/${total}]${RESET} ${name}`);
}

export function setupHeader(): void {
  const bar = "=".repeat(40);
  console.log(`${CYAN}${bar}${RESET}`);
  console.log(`${CYAN}${"WORKSPACE SETUP".padStart(27).padEnd(40)}${RESET}`);
  console.log(`${CYAN}${bar}${RESET}`);
  console.log();
}

export function setupFooter(errors: string[], duration: number): void {
  console.log();
  const bar = "=".repeat(40);
  console.log(bar);
  if (errors.length > 0) {
    const s = errors.length > 1 ? "s" : "";
    console.log(
      `${RED}✗ Setup failed (${errors.length} error${s}) in ${duration.toFixed(1)}s${RESET}`,
    );
  } else {
    console.log(`${GREEN}✓ Setup complete (${duration.toFixed(1)}s)${RESET}`);
  }
  console.log(bar);
}

export function preflightHeader(): void {
  console.log(`${CYAN}Pre-flight checks${RESET}`);
}

export function preflightFailed(): void {
  console.log(`\n${RED}Pre-flight failed.${RESET} Run: ./env/setup.ts`);
}
