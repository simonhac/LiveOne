#!/usr/bin/env tsx
/**
 * usher CLI — run the collector loop from usher.yaml, or dry-run a read.
 *
 * The usher normally runs inside the Next.js server (started by ../instrumentation.ts) so it can also
 * serve the inspector dashboard. This CLI is for local dev / one-shot diagnostics without the server.
 *
 *   npm run usher                 # run the loop (reads usher.yaml, pushes to gusher)
 *   npm run usher -- --once       # one tick per source (read → push) then exit
 *   npm run usher -- --dry        # read each source once + print the reading set; no push
 *   npm run usher -- --config path/to/usher.yaml
 *
 * Config path: --config, else $USHER_CONFIG, else ./usher.yaml. API keys come from the env vars named
 * by each source's `apiKeyEnv` (not needed for --dry).
 */

import { loadConfig, defaultConfigPath } from "./core/config";
import { createSource } from "./core/factory";
import { buildReadings } from "./core/build";
import { startUsher } from "./core/usher";

const HELP = `usher — device sources → gusher (/api/gush)

Usage: npm run usher -- [--once | --dry] [--config <path>]

  --once            one tick per source (read → push) then exit
  --dry             read each source once + print the reading set; do NOT push (no apiKey needed)
  --config <path>   usher.yaml path (default: $USHER_CONFIG or ./usher.yaml)
  --help
`;

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }
  const dry = args.includes("--dry");
  const once = args.includes("--once");
  const configPath = argValue(args, "--config") ?? defaultConfigPath();
  const ts = () => new Date().toISOString();
  const log = (m: string) => console.log(`${ts()} ${m}`);

  if (dry) {
    // Read each source once and print what we WOULD push. No apiKey / no network to gusher.
    const config = loadConfig(configPath);
    for (const sc of config.sources) {
      const source = createSource(sc, (m) => log(`  ${m}`));
      log(
        `[dry] reading ${sc.siteId} (${sc.type}) — manifest has ${source.manifest.length} point(s)…`,
      );
      try {
        const values = await source.read();
        const readings = buildReadings(source.manifest, values);
        console.log(
          JSON.stringify(
            { siteId: sc.siteId, measurementTime: ts(), readings },
            null,
            2,
          ),
        );
      } catch (e) {
        log(
          `[dry] ${sc.siteId} read failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    process.exit(0);
  }

  await startUsher({ configPath, once, log });
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
