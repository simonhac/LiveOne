/**
 * `resolveRunsConfig` — a `runs` card must not silently render under the wrong role.
 *
 * 🛑 The schema is a `strictObject`, so ONE unrecognised key is a parse failure. The plugin used to
 * absorb that into the schema's default, which meant an EV card rendered as a GENERATOR card: wrong
 * title, wrong `?role=` fetch, wrong live badge, every part of it confident and none of it flagged.
 * Same house rule as `resolveHeatmapConfig` / `resolveDailyStripeConfig` — a card that cannot read its
 * own config says so rather than guessing. See `docs/plans/exact-resolution-or-refuse.md`.
 */
import { describe, it, expect } from "@jest/globals";
import { resolveRunsConfig } from "../card-types";

describe("resolveRunsConfig", () => {
  it("reads an explicit role", () => {
    expect(resolveRunsConfig({ role: "ev" })).toEqual({ role: "ev" });
    expect(resolveRunsConfig({ role: "generator" })).toEqual({
      role: "generator",
    });
  });

  it("defaults to the generator when config is ABSENT — required back-compat", () => {
    // A doc written before the rename carries no config and meant the generator. This is the one
    // case where defaulting is correct, because nothing was asked for.
    expect(resolveRunsConfig(undefined)).toEqual({ role: "generator" });
    expect(resolveRunsConfig(null)).toEqual({ role: "generator" });
    expect(resolveRunsConfig({})).toEqual({ role: "generator" });
  });

  it("🛑 returns null for an unrecognised key rather than defaulting to the generator", () => {
    // The regression. `strictObject` rejects the whole object, and the old code turned that into
    // `role: "generator"` — silently re-roling someone's EV card.
    expect(resolveRunsConfig({ role: "ev", deviceSystemId: 13 })).toBeNull();
    expect(resolveRunsConfig({ typo: true })).toBeNull();
  });

  it("returns null for a role outside the enum", () => {
    // e.g. a trackable role added to `lib/roles/registry.ts` but not to this schema — the two are
    // kept in step by hand, so this is a reachable state, and it must not read as "generator".
    expect(resolveRunsConfig({ role: "hws" })).toBeNull();
    expect(resolveRunsConfig({ role: "" })).toBeNull();
  });

  it("returns null for a non-object config", () => {
    expect(resolveRunsConfig("ev")).toBeNull();
    expect(resolveRunsConfig(["ev"])).toBeNull();
  });
});
