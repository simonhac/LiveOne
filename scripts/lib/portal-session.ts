/**
 * A logged-in vendor-portal session, reused across runs — shared by the energy archive downloaders.
 *
 * 🛑 **No script here ever handles a password.** Each vendor gets its own PERSISTENT Chrome profile:
 * you log in by hand once, the cookies and tokens live in that profile, and every later run finds
 * itself already authenticated. Requests then go through the browser context, so the session travels
 * with them without ever being extracted. Anything that asked for credentials — even via env — would
 * be putting a password somewhere it can be read.
 *
 * Headed on purpose. If a profile has gone stale the only way forward is for a human to log in, and
 * a headless run would hang with nothing to look at.
 */
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

/**
 * Where profiles live. Outside any archive directory: these hold live session cookies, and an
 * archive is something you would happily copy, sync or share.
 */
export const PROFILE_ROOT = path.join(
  process.env.HOME ?? ".",
  ".config",
  "energy-archive",
  "profiles",
);

export interface SessionOptions {
  /** Profile directory name — one per vendor, so sessions never collide. */
  name: string;
  url: string;
  /** True once the session is usable. Prefer probing the API over inspecting the URL. */
  isReady: (page: Page) => Promise<boolean>;
  loginHint: string;
  timeoutMs?: number;
}

export async function openSession({
  name,
  url,
  isReady,
  loginHint,
  timeoutMs = 10 * 60_000,
}: SessionOptions): Promise<{ context: BrowserContext; page: Page }> {
  // `channel: "chrome"` uses the Google Chrome already installed rather than a Playwright-managed
  // build, so there is no browser download to keep in step with the library version. The profile is
  // its own directory, so this never touches your everyday Chrome session.
  const context = await chromium.launchPersistentContext(
    path.join(PROFILE_ROOT, name),
    {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 900 },
    },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded" });

  if (await isReady(page).catch(() => false)) return { context, page };

  console.log(`\n  >>> ${loginHint}`);
  console.log(
    `  >>> Waiting up to ${Math.round(timeoutMs / 60_000)} minutes.\n`,
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (await isReady(page).catch(() => false)) {
      console.log("  Logged in.\n");
      return { context, page };
    }
  }
  await context.close();
  throw new Error(`Timed out waiting for login on ${name}`);
}

/** Inclusive list of "YYYY-MM-DD" from `from` to `to`. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse `--flag=value` / `--flag` pairs off argv. */
export function args(
  argv: string[] = process.argv.slice(2),
): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

/** A required flag, with a message that names what is missing rather than crashing on undefined. */
export function requireFlag(
  flags: Record<string, string | true>,
  name: string,
  hint: string,
): string {
  const v = flags[name];
  if (typeof v !== "string" || !v) {
    console.error(`error: --${name} is required\n  ${hint}`);
    process.exit(2);
  }
  return v;
}

/** Today in a fixed-offset local zone, as YYYY-MM-DD. */
export function localToday(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** CSV cell: empty for null/undefined — an absent reading is NOT a zero. */
export const cell = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v);

/** RFC-4180-enough quoting for a header name that may contain a comma or quote. */
export function csvHeader(name: string): string {
  return /[",\n]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name;
}

// ---------------------------------------------------------------------------
// manifest.md
// ---------------------------------------------------------------------------

/**
 * One contiguous run of missing days, so a manifest reads as gaps rather than a wall of dates.
 */
export interface MissingRun {
  from: string;
  to: string;
  days: number;
}

/** Collapse a SORTED list of "YYYY-MM-DD" into contiguous runs. */
export function collapseRuns(days: string[]): MissingRun[] {
  const out: MissingRun[] = [];
  for (const d of days) {
    const prev = out[out.length - 1];
    if (prev && (Date.parse(d) - Date.parse(prev.to)) / 86_400_000 === 1) {
      prev.to = d;
      prev.days++;
    } else out.push({ from: d, to: d, days: 1 });
  }
  return out;
}

export interface ColumnRow {
  column: string;
  units: string;
  first: string | null;
  last: string | null;
  days: number | null;
  blank: string;
}

export interface ManifestInput {
  title: string;
  /** What one row IS, and what bounds the span. */
  intro: string;
  source: [string, string][];
  coverage: [string, string][];
  gaps: MissingRun[];
  columns: ColumnRow[];
  notes: string[];
  provenance: [string, string][];
}

/** Escape a cell so a stray `|` cannot break the table. */
const md = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "—"
    : String(v).replace(/\|/g, "\\|");

function table(headers: string[], rows: unknown[][]): string {
  const head = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
  if (rows.length === 0)
    return `${head}\n| ${headers.map(() => "—").join(" | ")} |`;
  return [head, ...rows.map((r) => `| ${r.map(md).join(" | ")} |`)].join("\n");
}

/**
 * Render a session manifest as Markdown, in the shape
 * `config/energy-monitoring-filing.md` specifies (hac-admin).
 *
 * 🛑 `coverage` describes the FILES BESIDE IT; run statistics belong in `provenance`. One archive
 * here briefly carried a one-day span beside an eight-year row count, because a retry run had
 * overwritten the manifest. Keeping the two apart is what stops that.
 */
export function renderManifest(m: ManifestInput): string {
  const out = [`# ${m.title}`, "", m.intro, ""];
  out.push("## Source", "", table(["Field", "Value"], m.source), "");
  out.push("## Coverage", "", table(["Field", "Value"], m.coverage), "");
  out.push(
    "## Gaps",
    "",
    table(
      ["From", "To", "Days"],
      m.gaps.map((g) => [g.from, g.to, g.days]),
    ),
    "",
  );
  out.push(
    "## Columns",
    "",
    table(
      ["Column", "Units", "First", "Last", "Days", "Blank"],
      m.columns.map((c) => [
        c.column,
        c.units,
        c.first,
        c.last,
        c.days,
        c.blank,
      ]),
    ),
    "",
  );
  if (m.notes.length)
    out.push("## Notes", "", ...m.notes.map((n) => `- ${n}`), "");
  out.push("## Provenance", "", table(["Field", "Value"], m.provenance), "");
  return out.join("\n");
}
