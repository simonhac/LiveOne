import { describe, expect, it, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression-tests the colour-token ratchet (scripts/check-colour-tokens.mjs).
 *
 * The gate is the only thing that makes the sweep's "done" a stable state: a reintroduced
 * `text-gray-400` still RENDERS — `@theme` adds to the default palette rather than replacing it —
 * so nothing else would notice the vocabulary decaying one dialog at a time. That makes the
 * guard's own correctness load-bearing, and a false NEGATIVE the expensive direction.
 *
 * Runs the real script as a subprocess over temp fixtures (same approach, and the same ESM/CJS
 * reasoning, as check-readings-boundary.test.ts).
 */
const repoRoot = join(__dirname, "..", "..");
const script = join(repoRoot, "scripts", "check-colour-tokens.mjs");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write `source` into a fake scoped file and run the guard over it. */
function check(source: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "colour-tokens-"));
  dirs.push(root);
  mkdirSync(join(root, "components", "dashboard"), { recursive: true });
  writeFileSync(join(root, "components/dashboard/fixture.tsx"), source);
  try {
    const out = execFileSync(
      "node",
      [script, "--root", root, "components/dashboard"],
      { cwd: repoRoot, stdio: "pipe" },
    ).toString();
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: err.status, out: err.stdout + "" + err.stderr };
  }
}

describe("colour-token guard", () => {
  it("passes on the real dashboard", () => {
    expect(() =>
      execFileSync("node", [script], { cwd: repoRoot, stdio: "pipe" }),
    ).not.toThrow();
  });

  it.each([
    "text-gray-400",
    "bg-gray-700/30",
    "border-white/[0.07]",
    "text-white",
    "bg-black/50",
    "divide-gray-800",
    "accent-green-600",
    "fill-yellow-400",
  ])("flags the palette class %s", (cls) => {
    const r = check(`export const a = <div className="${cls} p-2" />;\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain(cls);
  });

  it.each(["bg-[#1C1C1E]", "text-[rgb(40,49,66)]", "bg-[oklch(21%_0_0)]"])(
    "flags the hard-coded colour %s",
    (cls) => {
      // 🛑 This half earned its keep immediately: it found `bg-[#1C1C1E]` in the skeleton,
      // `bg-[#2C2C2E]` in the stale badge and Amber's `bg-[rgb(40,49,66)]` — four colours no
      // palette-class grep could ever see. Without it the guard would have called the dashboard
      // clean while three surfaces were still hard-coded.
      const r = check(`export const a = <div className="${cls}" />;\n`);
      expect(r.code).toBe(1);
      expect(r.out).toContain(cls);
    },
  );

  it.each([
    "text-ink-muted",
    "bg-surface",
    "border-line-soft",
    "text-ok",
    "text-series-battery",
    "bg-skeleton-quiet",
    "text-warn-ink-strong",
    "accent-ok",
    "bg-tile-skeleton",
    "text-tile-ink-idle",
  ])("does not mistake the token %s for a palette class", (cls) => {
    // Token names start with the same utility prefixes, so a sloppy regex flags every one of them
    // and the gate becomes unusable on the very code it exists to protect.
    expect(check(`export const a = <div className="${cls}" />;\n`).code).toBe(
      0,
    );
  });

  it("does not flag prose about colours", () => {
    // Every architecture doc and half the module comments name `text-gray-400` to explain it.
    const r = check(`
      /* The lines chart carried md:bg-gray-800 md:border. */
      // was text-white, now text-ink
      export const a = 1; // {/* bg-red-500 stays literal: a debug badge */}
    `);
    expect(r.code).toBe(0);
  });

  it("still sees a literal on a line that also carries a comment", () => {
    const r = check(
      `export const a = <div className="text-gray-400" />; // TODO\n`,
    );
    expect(r.code).toBe(1);
  });

  it("does not treat a URL's double slash as a comment", () => {
    const r = check(
      `const u = "https://x.test/a"; export const a = <p className="text-gray-400" />;\n`,
    );
    expect(r.code).toBe(1);
  });

  it("scopes to the dashboard, never the admin screens", () => {
    const src = require("node:fs").readFileSync(script, "utf8") as string;
    const scope = src.slice(
      src.indexOf("export const SCOPE"),
      src.indexOf("];", src.indexOf("export const SCOPE")),
    );
    expect(scope).toContain("components/dashboard");
    expect(scope).not.toContain("app/admin");
  });
});
