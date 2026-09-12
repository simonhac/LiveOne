import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  trialQuery,
  validateTrialPage,
} from "../../lib/collectors/trial-artifacts";

async function main() {
  const [endpoint, pollerId, revision, vendorSiteId, start, end, asOf, output] =
    process.argv.slice(2);
  if (!output)
    throw new Error(
      "Usage: export-trial.ts HTTPS_EXPORT_URL POLLER_UUID REVISION SITE_ID START END AS_OF NEW_OUTPUT_DIR",
    );
  const token = process.env.GOUSHER_RECEIVER_TOKEN;
  if (!token) throw new Error("Set GOUSHER_RECEIVER_TOKEN");
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/export" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use the private HTTPS /export endpoint");
  const query = trialQuery.parse({
    pollerId,
    revision: Number(revision),
    vendorSiteId,
    start,
    end,
    asOf,
  });
  await mkdir(output, { mode: 0o700 });
  let cursor = "",
    lastId = "";
  for (let index = 0; index < 10000; index++) {
    url.search = new URLSearchParams({
      pollerId,
      revision,
      start,
      end,
      asOf,
      cursor,
    }).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `Trial export failed with HTTP ${response.status}; retained pages are incomplete`,
      );
    const raw = await response.json();
    const page = validateTrialPage(raw, query);
    for (const b of page.batches) {
      if (b.id <= lastId) throw new Error("Trial batch order did not advance");
      lastId = b.id;
    }
    await writeFile(
      join(output, `${String(index).padStart(5, "0")}.json`),
      JSON.stringify(raw, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    if (!page.nextCursor) {
      await writeFile(
        join(output, "complete.json"),
        JSON.stringify({ version: 1, ...query, pages: index + 1 }, null, 2) +
          "\n",
        { flag: "wx", mode: 0o600 },
      );
      return;
    }
    if (page.nextCursor <= cursor)
      throw new Error("Trial cursor did not advance");
    cursor = page.nextCursor;
  }
  throw new Error("Trial export exceeded page limit");
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
