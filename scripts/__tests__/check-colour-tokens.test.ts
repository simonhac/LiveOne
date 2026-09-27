import { describe, expect, it, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
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

/**
 * The guard's own SCOPE and EXEMPTIONS, read from the real module.
 *
 * ts-jest compiles this file to CJS, so it cannot `import` an `.mjs` — but it can ask node to.
 * That beats regex-parsing the source (which the "never the admin screens" case below still does,
 * because that one is deliberately asserting on the source TEXT) since it cannot drift from what
 * the script actually runs with.
 */
type Exemption = { file: string; classes: string[]; why: string };
const { SCOPE, EXEMPTIONS } = JSON.parse(
  execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import { SCOPE, EXEMPTIONS } from ${JSON.stringify(script)};
       process.stdout.write(JSON.stringify({ SCOPE, EXEMPTIONS }));`,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  ).toString(),
) as { SCOPE: string[]; EXEMPTIONS: Exemption[] };

/** Every colour literal in `file`, exemptions ignored — i.e. what the entry SHOULD describe. */
function literalsIgnoringExemptions(file: string): string[] {
  let out: string;
  try {
    out = execFileSync("node", [script, "--no-exemptions", file], {
      cwd: repoRoot,
      stdio: "pipe",
    }).toString();
  } catch (e) {
    const err = e as { stdout: Buffer; stderr: Buffer };
    out = err.stdout + "" + err.stderr;
  }
  // `  components/X.tsx:99  bg-gray-800/40`
  return [
    ...new Set([...out.matchAll(/^\s+\S+:\d+\s+(\S+)$/gm)].map((m) => m[1])),
  ].sort();
}

/**
 * Write a whole fake tree and run the guard with the reachability half switched on.
 *
 * `files` is repo-relative path -> source. `components/dashboard` is the scoped path, so anything
 * elsewhere in the tree is reachable-but-unscoped if something scoped imports it.
 */
function checkClosure(files: Record<string, string>): {
  code: number;
  out: string;
} {
  const root = mkdtempSync(join(tmpdir(), "colour-closure-"));
  dirs.push(root);
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  try {
    const out = execFileSync(
      "node",
      [script, "--root", root, "--closure", "components/dashboard"],
      { cwd: repoRoot, stdio: "pipe" },
    ).toString();
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: err.status, out: err.stdout + "" + err.stderr };
  }
}

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

  it("reports the line the literal is actually on, past a block comment", () => {
    // 🛑 Regression. `stripComments` used to replace a whole block comment with ONE space, so
    // every line number after it was short by the comment's height — format-value.tsx:53 was
    // reported as :33. The class still matched, so the guard looked fine while sending you to the
    // wrong function.
    const r = check(
      `/**\n * a\n * b\n * c\n */\nexport const a = <div className="text-gray-400" />;\n`,
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/fixture\.tsx:6\s+text-gray-400/);
  });

  it("does not treat a URL's double slash as a comment", () => {
    const r = check(
      `const u = "https://x.test/a"; export const a = <p className="text-gray-400" />;\n`,
    );
    expect(r.code).toBe(1);
  });

  /**
   * The half an allow-list cannot do for itself.
   *
   * `lib/point/format-value.tsx` rendered a `text-gray-400` that three scoped files import, and the
   * gate called the dashboard clean for the whole life of the token layer — because the file was
   * not itself in SCOPE. A literal one import away from the thing you are guarding is still on the
   * screen.
   */
  describe("reachability", () => {
    it("finds a literal in an unscoped file that a scoped file imports", () => {
      const r = checkClosure({
        "components/dashboard/card.tsx": `import { Bit } from "@/lib/bit";\nexport const a = <Bit />;\n`,
        "lib/bit.tsx": `export const Bit = () => <span className="text-gray-400" />;\n`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("lib/bit.tsx");
      expect(r.out).toContain("text-gray-400");
      expect(r.out).toContain("REACHES but does not scope");
    });

    it("passes when the imported file is clean", () => {
      const r = checkClosure({
        "components/dashboard/card.tsx": `import { Bit } from "@/lib/bit";\nexport const a = <Bit />;\n`,
        "lib/bit.tsx": `export const Bit = () => <span className="text-ink-muted" />;\n`,
      });
      expect(r.code).toBe(0);
    });

    it("follows a barrel re-export", () => {
      const r = checkClosure({
        "components/dashboard/card.tsx": `import { Bit } from "@/lib/kit";\nexport const a = <Bit />;\n`,
        "lib/kit/index.ts": `export * from "./bit";\n`,
        "lib/kit/bit.tsx": `export const Bit = () => <span className="bg-red-500" />;\n`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("lib/kit/bit.tsx");
    });

    it("follows a dynamic import — how next/dynamic loads a component", () => {
      const r = checkClosure({
        "components/dashboard/card.tsx": `const B = dynamic(() => import("@/lib/bit"));\n`,
        "lib/bit.tsx": `export const Bit = () => <span className="bg-[#1C1C1E]" />;\n`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("lib/bit.tsx");
    });

    it("follows a relative specifier, and transitively", () => {
      const r = checkClosure({
        "components/dashboard/card.tsx": `import { A } from "../../lib/one";\n`,
        "lib/one.ts": `export { A } from "./two";\n`,
        "lib/two.tsx": `export const A = () => <b className="text-gray-400" />;\n`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("lib/two.tsx");
    });

    it("ignores a test file, which cannot render to a user", () => {
      const r = checkClosure({
        "components/dashboard/card.tsx": `import { f } from "@/lib/__tests__/helper";\n`,
        "lib/__tests__/helper.tsx": `export const f = () => <b className="text-gray-400" />;\n`,
      });
      expect(r.code).toBe(0);
    });

    it("never wanders into the admin screens from the real SCOPE", () => {
      // The gate's political boundary. If something scoped ever imports an admin screen, the
      // closure would drag ~1,500 literals in and the guard would be unusable overnight — so this
      // is checked, not remembered.
      const reached = JSON.parse(
        execFileSync(
          "node",
          [
            "--input-type=module",
            "-e",
            `import { reachableFrom, SCOPE } from ${JSON.stringify(script)};
             process.stdout.write(JSON.stringify(reachableFrom(${JSON.stringify(repoRoot)}, SCOPE)));`,
          ],
          { cwd: repoRoot, stdio: "pipe" },
        ).toString(),
      ) as string[];
      expect(reached.filter((f) => f.startsWith("app/admin/"))).toEqual([]);
    });
  });

  /**
   * The ratchet itself. The script's header has said "THIS LIST MAY ONLY SHRINK" since the layer
   * landed, and the architecture doc said this file enforced it — but nothing did, for months. A
   * rule that lives only in a comment is a rule the next person can delete by not reading it.
   */
  describe("the exemption list", () => {
    // 🛑 Lower this as entries go. NEVER raise it: an exemption says a colour has no meaning worth
    // naming, and a NEW one nearly always means the opposite argument lost.
    const CEILING = 2;

    it(`holds at most ${CEILING} entries`, () => {
      expect(EXEMPTIONS.length).toBeLessThanOrEqual(CEILING);
    });

    // Pins the COUNT, not the file set, on purpose: consolidating two entries onto one shared
    // component is a shrink in the only sense that matters, and a file-set pin would forbid it.
    it.each(EXEMPTIONS.map((e) => [e.file, e] as const))(
      "%s still carries exactly the classes it claims",
      (_file, entry) => {
        expect(literalsIgnoringExemptions(entry.file)).toEqual(
          [...new Set(entry.classes)].sort(),
        );
      },
    );

    it.each(EXEMPTIONS.map((e) => e.file))("%s is inside SCOPE", (file) => {
      // An exemption for an unscoped file is a no-op that reads as coverage.
      expect(SCOPE.some((s) => file === s || file.startsWith(`${s}/`))).toBe(
        true,
      );
    });

    it("moves in lockstep with the doc's 'Deliberately left literal' section", () => {
      const doc = readFileSync(
        join(repoRoot, "docs/architecture/colour-tokens.md"),
        "utf8",
      );
      const start = doc.indexOf("## Deliberately left literal");
      expect(start).toBeGreaterThan(-1);
      const end = doc.indexOf("\n## ", start + 1);
      const section = doc.slice(start, end === -1 ? undefined : end);

      // Every exemption is explained there...
      for (const e of EXEMPTIONS) {
        expect(section).toContain(basename(e.file).replace(/\.tsx?$/, ""));
      }
      // ...and it gives no bullet to a file that is not one, which is how a retired exemption gets
      // left behind as documentation of a rule nobody follows any more.
      //
      // Only each bullet's bold LEAD counts — that is the bullet's subject. The body is prose and
      // may name whatever it needs to (the badge bullet says which two files used to copy it;
      // `TileSurface` is named as the destination the pre-tile-style cards are waiting on), and a
      // guard that forbade that would just push the explanation out of the doc.
      const exempt = new Set(EXEMPTIONS.map((e) => e.file));
      const leads = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map(
        (m) => m[1],
      );
      expect(leads.length).toBeGreaterThan(0);
      for (const lead of leads) {
        for (const m of lead.matchAll(/`([A-Z][A-Za-z0-9]+)`/g)) {
          const candidate = `components/${m[1]}.tsx`;
          if (!existsSync(join(repoRoot, candidate))) continue;
          expect(exempt).toContain(candidate);
        }
      }
    });
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
