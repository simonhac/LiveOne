/** Save reference pages without putting a credential in shell arguments or output files. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { referenceQuery } from "../../lib/collectors/reference-export";

async function main() {
  const [base, pollerId, revision, pointId, start, end, output] =
    process.argv.slice(2);
  if (!output)
    throw new Error(
      "Usage: export-readings.ts HTTPS_BASE POLLER_UUID REVISION POINT_UUID START END NEW_OUTPUT_DIR",
    );
  const token = process.env.LIVEONE_COLLECTOR_TOKEN;
  if (!token)
    throw new Error(
      "Set LIVEONE_COLLECTOR_TOKEN to the assigned collector credential",
    );
  const url = new URL("/api/collectors/me/readings", base);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use an HTTPS origin without embedded credentials");
  const query = referenceQuery.parse({
    pollerId,
    revision,
    pointId,
    start,
    end,
    asOf: new Date().toISOString(),
  });
  // Exclusive directory creation prevents mixing a new export with retained evidence.
  await mkdir(output, { recursive: false, mode: 0o700 });
  let cursor: string | null = null;
  let metadata: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 10000; page++) {
    url.search = new URLSearchParams(
      Object.entries({ ...query, ...(cursor ? { cursor } : {}) }).map(
        ([key, value]) => [key, String(value)],
      ),
    ).toString();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `Export failed with HTTP ${response.status}; retained pages are incomplete`,
      );
    const data = await response.json();
    if (
      data.version !== 1 ||
      data.pollerId !== pollerId ||
      data.revision !== query.revision ||
      data.point?.id !== pointId ||
      data.asOf !== query.asOf ||
      data.start !== start ||
      data.end !== end ||
      !Array.isArray(data.readings) ||
      data.readings.length > query.limit ||
      !(data.nextCursor === null || typeof data.nextCursor === "string")
    )
      throw new Error("Unexpected export response");
    const currentMetadata = JSON.stringify({
      deviceId: data.deviceId,
      point: data.point,
    });
    if (metadata !== undefined && metadata !== currentMetadata)
      throw new Error(
        "Point metadata changed during export; restart with a new output directory",
      );
    metadata = currentMetadata;
    await writeFile(
      join(output, `${String(page).padStart(5, "0")}.json`),
      JSON.stringify(data, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    cursor = data.nextCursor;
    if (cursor === null) {
      await writeFile(
        join(output, "complete.json"),
        JSON.stringify({ version: 1, ...query, pages: page + 1 }, null, 2) +
          "\n",
        { flag: "wx", mode: 0o600 },
      );
      return;
    }
    if (seen.has(cursor)) throw new Error("Export cursor did not advance");
    seen.add(cursor);
  }
  throw new Error("Export page limit exceeded; retained pages are incomplete");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
