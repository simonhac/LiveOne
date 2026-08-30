/**
 * The CLI registry — which files are operator CLIs, and what standard each is held to.
 *
 * PORTED in spirit from nanti's `config/cli-tiers.yaml`. It is a TypeScript module rather than YAML
 * because LiveOne has no YAML dependency (only transitive ones) and no `config/` directory, and
 * because the manifest's value — comments justifying each entry — is native here, with type
 * checking and go-to-definition thrown in.
 *
 * 🛑 THE TIER IS THE CONTRACT. A new tool defaults to UNLISTED, and the census in
 * `scripts/ops/cli-conformance.ts` reports every unlisted first-party CLI. That direction matters:
 * for a year nanti's checker built its target list *from* the manifest, so an unlisted file was not
 * walked at all — not linted, not documented, not covered by any rule — and the check stayed green
 * while eight CLIs went through hand-rolling `process.argv`. Adding a file here is a deliberate act;
 * omitting one is a finding, not an exemption.
 */

export type Tier = "a" | "b" | "c" | "lib";

export interface TierManifest {
  /**
   * Tier A — agent-facing: named in CLAUDE.md, in a skill, or run by a scheduled job.
   * Full conformance: the shared harness, `--format human|json`, stdout purity, `--help`, the
   * exit-code vocabulary, and a `when` clause. Documented in the generated reference.
   */
  a: readonly string[];
  /**
   * Tier B — live but rarely run: backfills, migrations, one-shot repair tools. Held to the shared
   * harness, exit codes and `--help`; may still print progress to stdout. Documented.
   */
  b: readonly string[];
  /**
   * Tier C — one-off, superseded, or not an agent-facing CLI at all (harness hooks, lifecycle
   * scripts). Exempt from the checker, and NOT documented. Parking something here is a decision,
   * which is why it is recorded rather than left unlisted.
   */
  c: readonly string[];
  /**
   * Not CLIs, but anything they print lands in some tool's stdout — so they are held to the stream
   * rule (data on stdout, diagnostics on stderr) and nothing else.
   */
  lib: readonly string[];
}

export const TIERS: TierManifest = {
  a: [
    // The operator CLI. One entrypoint; each domain is a composable module beneath it.
    "scripts/ops/liveone.ts",
    // The generator for the committed reference. Agent-facing because a stale catalogue is how
    // discovery starts lying.
    "scripts/ops/cli-reference.ts",
    // The census + conformance checker.
    "scripts/ops/cli-conformance.ts",
  ],
  b: [
    // Config-document migrations. Run by hand against prod, rarely, with a minted role. Not yet on
    // the shared harness — they predate it, and they are on the conversion list.
    "scripts/utils/migrate-card-type.ts",
    "scripts/utils/add-generator-tile.ts",
    // Found by the revisions tranche: a FOURTH hand-rolled CAS writer that escaped both the dedup
    // and the census (whose root is scripts/ops). Folded onto writeDoc; listed so it stays seen.
    "scripts/utils/remove-card.ts",
  ],
  c: [
    // The `dashboard` domain and its plumbing — composed by scripts/ops/liveone.ts, and
    // deliberately WITHOUT entrypoints of their own so they can be imported. Not CLIs themselves,
    // so they are not documented separately; the reference documents them through `liveone`.
    "scripts/ops/dashboard/cli.ts",
    "scripts/ops/dashboard/db.ts",
    // The `auth` domain — composed by liveone.ts, same rules as the dashboard module.
    "scripts/ops/auth/cli.ts",
    // The `find` verb, likewise composed rather than an entrypoint.
    "scripts/ops/find/cli.ts",
    "scripts/ops/dashboard/transport.ts",
  ],
  lib: [],
};

export interface Tiers {
  /** Repo-relative path → its tier. */
  tierOf: ReadonlyMap<string, Tier>;
  /** The declared paths of one tier. */
  paths(tier: Tier): readonly string[];
  /** Every declared path, any tier. */
  all(): readonly string[];
}

/**
 * The ONE reader of the manifest.
 *
 * 🛑 One file, one tier — a duplicate is a load-time error. nanti's loader was last-writer-wins
 * over `a, b, c, lib`; since that order runs strict→loose, a path listed twice was reliably held to
 * the WEAKER standard, silently. One of its files sat in both `a` and `b` from day one.
 */
export function loadTiers(manifest: TierManifest = TIERS): Tiers {
  const tierOf = new Map<string, Tier>();
  for (const tier of ["a", "b", "c", "lib"] as const) {
    for (const p of manifest[tier]) {
      const already = tierOf.get(p);
      if (already)
        throw new Error(
          `"${p}" is listed in both tier ${already} and tier ${tier}\n` +
            `  one file, one tier — a duplicate would silently be held to the weaker standard\n` +
            `  → remove the entry from whichever tier is wrong`,
        );
      tierOf.set(p, tier);
    }
  }
  return {
    tierOf,
    paths: (tier) => manifest[tier],
    all: () => [...tierOf.keys()],
  };
}
