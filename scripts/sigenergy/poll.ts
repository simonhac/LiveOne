#!/usr/bin/env tsx
/**
 * Sigenergy cloud API — CLI proof.
 *
 * Proves that a household Sigenergy system can be polled remotely from just the owner's mySigen
 * login: it logs in, discovers the station, prints a live PV/battery/grid/load/EV snapshot, then
 * loops repeated polls at a fixed interval to demonstrate that regular (5-minute) polling works
 * without tripping the cloud API's rate limit.
 *
 * Run:
 *   npm run sigen:poll -- --once
 *   npm run sigen:poll -- --count=3 --interval=300
 *   npm run sigen:poll -- --probe-ratelimit
 *   npm run sigen:poll -- --help
 *
 * Credentials come from .env.local (loaded via `tsx --env-file=.env.local`):
 *   SIGENERGY_USERNAME=<mySigen email>
 *   SIGENERGY_PASSWORD=<mySigen password>
 *   SIGENERGY_REGION=aus            # optional; default "aus" (Australia/NZ)
 *
 * Flags:
 *   --once                 single snapshot then exit (default when neither --once nor --count given)
 *   --count=N              poll N times (default 1)
 *   --interval=SECONDS     seconds between polls (default 300 = 5 min)
 *   --auth=legacy|openapi|auto   force an auth path (default auto: legacy then openapi)
 *   --region=aus|eu|apac|us|cn   override region (default from env or "aus")
 *   --raw                  print full raw JSON for each API response
 *   --probe-ratelimit      fire two back-to-back energy-flow calls to confirm the sub-5-min throttle
 *   --help                 show this help
 *
 * READ-ONLY: this tool only issues GET/login requests to the owner's own account. It writes nothing.
 */

import {
  SigenClient,
  SigenError,
  type SigenAuthMode,
  type SigenRegion,
  type SigenEnergyFlow,
} from "./sigen-client";

// ── arg parsing ─────────────────────────────────────────────────────────────
type Args = {
  once: boolean;
  count: number;
  intervalSec: number;
  auth: SigenAuthMode;
  region?: SigenRegion;
  raw: boolean;
  probeRateLimit: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    flags.set(m[1], m[2] ?? true);
  }
  const num = (k: string, dflt: number) => {
    const v = flags.get(k);
    if (v == null || v === true) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const countGiven = flags.has("count");
  return {
    once: flags.has("once") || !countGiven,
    count: countGiven ? Math.max(1, Math.floor(num("count", 1))) : 1,
    intervalSec: Math.max(1, Math.floor(num("interval", 300))),
    auth: ((flags.get("auth") as string) || "auto") as SigenAuthMode,
    region: (flags.get("region") as SigenRegion | undefined) || undefined,
    raw: flags.has("raw"),
    probeRateLimit: flags.has("probe-ratelimit"),
    help: flags.has("help"),
  };
}

const HELP = `Sigenergy cloud API — CLI proof

Usage: npm run sigen:poll -- [flags]

  --once                 single snapshot then exit (default)
  --count=N              poll N times (default 1)
  --interval=SECONDS     seconds between polls (default 300 = 5 min)
  --auth=legacy|openapi|auto   force auth path (default auto)
  --region=aus|eu|apac|us|cn   override region (default env SIGENERGY_REGION or "aus")
  --raw                  print full raw JSON for each response
  --probe-ratelimit      two back-to-back calls to confirm the sub-5-min throttle
  --help                 show this help

Credentials (in .env.local): SIGENERGY_USERNAME, SIGENERGY_PASSWORD, SIGENERGY_REGION (optional).
`;

// ── formatting helpers ──────────────────────────────────────────────────────
function maskToken(t: string): string {
  if (t.length <= 12) return "***";
  return `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length})`;
}

function fmtPower(kw: number | null): string {
  if (kw == null) return "—";
  const w = Math.round(kw * 1000);
  return `${kw.toFixed(3)} kW (${w} W)`;
}

function fmtSnapshot(flow: SigenEnergyFlow): string {
  const rows = [
    ["PV", fmtPower(flow.pv)],
    ["Battery", fmtPower(flow.battery)],
    [
      "Battery SOC",
      flow.batterySoc == null ? "—" : `${flow.batterySoc.toFixed(1)} %`,
    ],
    ["Grid", fmtPower(flow.grid)],
    ["Load", fmtPower(flow.load)],
    ["EV charger", fmtPower(flow.ev)],
  ];
  return rows.map(([k, v]) => `    ${k.padEnd(12)} ${v}`).join("\n");
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "Z");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const username = process.env.SIGENERGY_USERNAME;
  const password = process.env.SIGENERGY_PASSWORD;
  const region = (args.region ||
    (process.env.SIGENERGY_REGION as SigenRegion | undefined) ||
    "aus") as SigenRegion;

  if (!username || !password) {
    console.error(
      "❌ Missing credentials. Add SIGENERGY_USERNAME and SIGENERGY_PASSWORD to .env.local\n" +
        "   (run with --help for details).",
    );
    process.exit(1);
  }

  console.log("═".repeat(70));
  console.log("  Sigenergy cloud API — CLI proof");
  console.log("═".repeat(70));
  console.log(`  Account : ${username.replace(/(.).*(@.*)/, "$1***$2")}`);
  console.log(`  Region  : ${region}`);
  console.log(`  Auth    : ${args.auth}`);
  console.log(
    `  Plan    : ${args.probeRateLimit ? "rate-limit probe" : args.count > 1 ? `${args.count} polls @ ${args.intervalSec}s` : "single snapshot"}`,
  );
  console.log("");

  const client = new SigenClient({
    username,
    password,
    region,
    authMode: args.auth,
    log: (m) => console.log(`  ${m}`),
  });

  // 1) Login ------------------------------------------------------------------
  console.log("① Logging in…");
  const token = await client.login();
  console.log(`   token   : ${maskToken(token.accessToken)}`);
  console.log(`   expires : ${new Date(token.expiresAt).toISOString()}`);
  console.log(`   refresh : ${token.refreshToken ? "yes" : "no"}`);
  console.log("");

  // 2) Discover station -------------------------------------------------------
  console.log("② Fetching station…");
  const station = await client.getStation();
  console.log(
    `   stationId : ${station.stationId ?? "(not found — see raw below)"}`,
  );
  if (station.name) console.log(`   name      : ${station.name}`);
  if (args.raw || !station.stationId) {
    console.log("   raw station response:");
    console.log(indent(JSON.stringify(station.raw, null, 2), 6));
  }
  console.log("");

  if (!station.stationId) {
    console.error(
      "❌ Could not extract a station id from the response above. Login works, but we need the\n" +
        "   real field name for the station id. Share the raw JSON and we'll adjust the extractor.",
    );
    process.exit(2);
  }

  // 3) Snapshot ---------------------------------------------------------------
  console.log("③ Energy-flow snapshot:");
  const first = await client.getEnergyFlow(station.stationId);
  console.log(fmtSnapshot(first));
  const foundFields = Object.entries(first)
    .filter(([k, v]) => k !== "raw" && v != null)
    .map(([k]) => k);
  console.log(
    `   fields resolved: ${foundFields.length ? foundFields.join(", ") : "(none!)"}`,
  );
  if (args.raw || foundFields.length === 0) {
    console.log("   raw energy-flow response:");
    console.log(indent(JSON.stringify(first.raw, null, 2), 6));
  }
  console.log("");

  // 4a) Rate-limit probe ------------------------------------------------------
  if (args.probeRateLimit) {
    console.log(
      "④ Rate-limit probe — firing a second energy-flow call immediately…",
    );
    try {
      await client.getEnergyFlow(station.stationId);
      console.log(
        "   ⚠️  Second immediate call SUCCEEDED — no per-endpoint throttle observed on back-to-back calls.\n" +
          "       (The documented limit is ~1/endpoint/5min; behaviour may differ for this account.)",
      );
    } catch (err) {
      if (err instanceof SigenError && err.kind === "rate-limit") {
        console.log(
          "   ✅ Second immediate call was THROTTLED — confirms the ~1/endpoint/5min limit.\n" +
            "       → polling must be spaced ≥5 min apart.",
        );
      } else {
        throw err;
      }
    }
    console.log("");
    printVerdict(token.authMode, foundFields, 1, 0, args.intervalSec);
    return;
  }

  // 4b) Polling loop ----------------------------------------------------------
  if (args.count > 1) {
    console.log(
      `④ Polling ${args.count}× at ${args.intervalSec}s intervals to prove regular polling…`,
    );
    let ok = 1; // the snapshot above counts as poll #1
    let rateLimited = 0;
    let otherErrors = 0;
    console.log(
      `   #1  ${nowIso()}  PV ${fmtCompact(first.pv)}  Batt ${fmtCompact(first.battery)} (SOC ${first.batterySoc ?? "—"}%)  Grid ${fmtCompact(first.grid)}  Load ${fmtCompact(first.load)}  EV ${fmtCompact(first.ev)}`,
    );

    for (let i = 2; i <= args.count; i++) {
      await sleep(args.intervalSec * 1000);
      try {
        const flow = await client.getEnergyFlow(station.stationId);
        ok++;
        console.log(
          `   #${i}  ${nowIso()}  PV ${fmtCompact(flow.pv)}  Batt ${fmtCompact(flow.battery)} (SOC ${flow.batterySoc ?? "—"}%)  Grid ${fmtCompact(flow.grid)}  Load ${fmtCompact(flow.load)}  EV ${fmtCompact(flow.ev)}`,
        );
      } catch (err) {
        if (err instanceof SigenError && err.kind === "rate-limit") {
          rateLimited++;
          console.log(
            `   #${i}  ${nowIso()}  ⛔ rate-limited (${err.message})`,
          );
        } else {
          otherErrors++;
          console.log(
            `   #${i}  ${nowIso()}  ❌ ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    console.log("");
    console.log(
      `   polled OK: ${ok}/${args.count}   rate-limited: ${rateLimited}   other errors: ${otherErrors}`,
    );
    console.log("");
    printVerdict(
      token.authMode,
      foundFields,
      ok,
      rateLimited,
      args.intervalSec,
    );
    return;
  }

  // Single-snapshot verdict.
  printVerdict(token.authMode, foundFields, 1, 0, args.intervalSec);
}

function fmtCompact(kw: number | null): string {
  return kw == null ? "—" : `${kw.toFixed(2)}kW`;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function printVerdict(
  authMode: string,
  fields: string[],
  okPolls: number,
  rateLimited: number,
  intervalSec: number,
) {
  console.log("─".repeat(70));
  const feasible = rateLimited === 0 && okPolls >= 1;
  const cadence =
    intervalSec >= 300
      ? `${Math.round(intervalSec / 60)}-min`
      : `${intervalSec}s`;
  if (feasible) {
    console.log(
      `✅ VERDICT: login via "${authMode}"; energy-flow fields [${fields.join(", ")}]; ` +
        `${okPolls} poll(s) OK, 0 rate-limit errors → ${cadence} polling is feasible.`,
    );
  } else {
    console.log(
      `⚠️  VERDICT: ${okPolls} poll(s) OK but ${rateLimited} were rate-limited at ${cadence} spacing — ` +
        `increase --interval (≥300s) and retry.`,
    );
  }
  console.log("─".repeat(70));
}

main().catch((err) => {
  if (err instanceof SigenError) {
    console.error(
      `\n❌ SigenError [${err.kind}]${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`,
    );
    if (err.body != null) {
      const body =
        typeof err.body === "string"
          ? err.body
          : JSON.stringify(err.body, null, 2);
      console.error(indent(body.slice(0, 1500), 4));
    }
    if (err.kind === "auth") {
      console.error(
        "\n   → Check SIGENERGY_USERNAME/PASSWORD, and try --auth=openapi (or --auth=legacy) and --region.",
      );
    }
    process.exit(3);
  }
  console.error("\n❌ Unexpected error:", err);
  process.exit(1);
});
