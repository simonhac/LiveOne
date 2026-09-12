import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assembleComparison } from "../../lib/collectors/trial-artifacts";

async function main() {
  const [policyFile, referenceDir, trialDir, output] = process.argv.slice(2);
  if (!output)
    throw new Error(
      "Usage: compare-exports.ts POLICY_JSON REFERENCE_DIR TRIAL_DIR NEW_OUTPUT_DIR",
    );
  const hashes: Record<string, string> = {};
  async function read(path: string) {
    const bytes = await readFile(path);
    hashes[path] = createHash("sha256").update(bytes).digest("hex");
    return JSON.parse(bytes.toString("utf8"));
  }
  async function artifact(dir: string) {
    const complete = await read(join(dir, "complete.json"));
    const count = z.number().int().min(1).max(10000).parse(complete.pages);
    const pages = [];
    for (let i = 0; i < count; i++)
      pages.push(await read(join(dir, `${String(i).padStart(5, "0")}.json`)));
    return { complete, pages };
  }
  const result = assembleComparison(
    await read(policyFile),
    await artifact(referenceDir),
    await artifact(trialDir),
  );
  await mkdir(output, { mode: 0o700 });
  for (const [name, data] of Object.entries({
    input: result.input,
    report: result.report,
    sources: { version: 1, sha256: hashes },
  })) {
    await writeFile(
      join(output, `${name}.json`),
      JSON.stringify(data, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  if (!result.report.passed) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
