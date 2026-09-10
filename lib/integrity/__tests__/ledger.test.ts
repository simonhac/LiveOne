import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "@jest/globals";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@/lib/db/planetscale/schema";
import {
  REFERENCE_LEDGER,
  columnKey,
  referenceCandidates,
  type LedgerEntry,
} from "../ledger";

/**
 * The census, enforced.
 *
 * Pure drizzle introspection — no DB connection. Its job is to make the ledger's completeness claim
 * mechanical rather than remembered: a new column that could hold a reference fails HERE, by name,
 * before it becomes an incident nobody can explain.
 *
 * It also PROVES the `fk` verdicts against `getTableConfig` rather than trusting them, which is the
 * difference between a census and a comment. A `protectedBy: "fk"` on a column Postgres does not
 * actually constrain would otherwise be the most dangerous possible entry: it reads as safe and is
 * the reason nobody wired a check.
 */

const key = (t: string, c: string) => `${t}.${c}`;
const ledgerByKey = new Map<string, LedgerEntry>(
  REFERENCE_LEDGER.map((e) => [columnKey(e.column), e]),
);

describe("the reference census is complete", () => {
  it("finds a plausible number of candidates (it cannot silently cover nothing)", () => {
    const candidates = referenceCandidates();
    expect(candidates.length).toBeGreaterThanOrEqual(50);
    // A handful of anchors: if the derivation rules ever stop matching these, the census has
    // narrowed and every assertion below would start passing vacuously.
    expect(candidates.map((c) => key(c.table, c.column))).toEqual(
      expect.arrayContaining([
        "dashboards.doc",
        "automations.trigger",
        "derivations.source_points",
        "users.default_dashboard_id",
        "point_commands.requested_by",
        "observations_outbox.device_rid",
      ]),
    );
  });

  it("excludes a row's own identity, and ONLY that", () => {
    const keys = referenceCandidates().map((c) => key(c.table, c.column));
    // A LONE primary-key column with no FK: identity, not reference.
    expect(keys).not.toContain("areas.id");
    expect(keys).not.toContain("users.clerk_user_id");
    // A column that is both primary key and foreign key is still a reference.
    expect(keys).toContain("derived_intervals.derivation_id");
    // 🛑 REGRESSION. The rule first read "part of the primary key", which excluded this — a Clerk
    // user reference with no FK, inside a composite PK — while every completeness assertion in this
    // file kept passing. A composite key is a TUPLE OF REFERENCES; only a lone column is identity.
    expect(keys).toContain("dashboard_grants.user_id");
  });

  it("treats a foreign key as a reference whatever it is named", () => {
    // Rule 1 exists so that a reference Postgres already knows about can never depend on the naming
    // heuristic to be seen. It happens to add nothing today (every FK column here also matches
    // `_id`/`_rid`), and that is precisely why it needs a test rather than an observation.
    const candidates = referenceCandidates();
    const fkColumns = candidates.filter((c) => c.fkOnDelete);
    expect(fkColumns.length).toBeGreaterThanOrEqual(20);
    for (const c of fkColumns)
      expect(
        candidates.some((x) => x.table === c.table && x.column === c.column)
          ? "ok"
          : `${c.table}.${c.column} has an FK but is not a candidate`,
      ).toBe("ok");
  });

  it("classifies every candidate column, by name", () => {
    for (const c of referenceCandidates()) {
      const k = key(c.table, c.column);
      const verdict = ledgerByKey.get(k)
        ? "ok"
        : `${k} could hold a reference and is not in REFERENCE_LEDGER — add it with a protectedBy verdict (lib/integrity/ledger.ts)`;
      expect(verdict).toBe("ok");
    }
  });

  it("has no stale entries", () => {
    const keys = new Set(
      referenceCandidates().map((c) => key(c.table, c.column)),
    );
    for (const e of REFERENCE_LEDGER) {
      const k = columnKey(e.column);
      const verdict = keys.has(k)
        ? "ok"
        : `${k} is in REFERENCE_LEDGER but no such column exists (renamed or dropped?)`;
      expect(verdict).toBe("ok");
    }
  });

  it("lists each column exactly once", () => {
    const seen = new Set<string>();
    for (const e of REFERENCE_LEDGER) {
      const k = columnKey(e.column);
      expect(seen.has(k) ? `${k} listed twice` : "ok").toBe("ok");
      seen.add(k);
    }
  });
});

describe("the verdicts hold up", () => {
  it("proves every `fk` claim against the schema", () => {
    const candidates = new Map(
      referenceCandidates().map((c) => [key(c.table, c.column), c]),
    );
    for (const e of REFERENCE_LEDGER) {
      if (e.verdict.protectedBy !== "fk") continue;
      const c = candidates.get(columnKey(e.column));
      const claim = columnKey(e.column);
      expect(
        c?.fkOnDelete
          ? "ok"
          : `${claim} claims protectedBy:"fk" but Postgres has no foreign key on it`,
      ).toBe("ok");
      expect(
        c?.fkOnDelete === e.verdict.onDelete
          ? "ok"
          : `${claim} claims ON DELETE ${e.verdict.onDelete}, schema says ${c?.fkOnDelete}`,
      ).toBe("ok");
    }
  });

  it("makes every non-fk verdict say why", () => {
    for (const e of REFERENCE_LEDGER) {
      if (e.verdict.protectedBy === "fk") continue;
      const claim = columnKey(e.column);
      // The explanation must sit on whatever is actually at risk. For a jsonb column declared to
      // hold no references, the load-bearing claim IS `holdsNoRefs` — "why is this loose" is then
      // allowed to be a short category label. Everywhere else the reason carries it alone.
      const [what, text] = e.holdsNoRefs
        ? ["holdsNoRefs", e.holdsNoRefs]
        : ["reason", e.verdict.reason];
      expect(
        text.trim().length > 40
          ? "ok"
          : `${claim} needs a real ${what}, not "${text}"`,
      ).toBe("ok");
    }
  });

  it("requires every jsonb column to declare its interior", () => {
    const jsonb = referenceCandidates().filter(
      (c) => c.columnType === "PgJsonb",
    );
    // 17 today. Pinned so that a new jsonb column cannot slip through as "not a reference column".
    expect(jsonb.length).toBe(17);
    for (const c of jsonb) {
      const k = key(c.table, c.column);
      const e = ledgerByKey.get(k);
      const declared = (e?.extract ? 1 : 0) + (e?.holdsNoRefs ? 1 : 0);
      expect(
        declared === 1
          ? "ok"
          : `${k} is jsonb and must supply exactly one of extract() or holdsNoRefs (has ${declared})`,
      ).toBe("ok");
    }
  });

  it("every extractor tolerates rubbish (a stored doc can be older than its type)", () => {
    for (const e of REFERENCE_LEDGER) {
      if (!e.extract) continue;
      for (const junk of [null, undefined, 0, "", [], {}, { source: 7 }])
        expect(Array.isArray(e.extract(junk))).toBe(true);
    }
  });
});

describe("the extractors read the shapes the writers store", () => {
  const extractor = (t: string, c: string) => {
    const e = ledgerByKey.get(key(t, c));
    if (!e?.extract) throw new Error(`${t}.${c} has no extractor`);
    return e.extract;
  };

  it("finds all three of an automation trigger's references", () => {
    const f = extractor("automations", "trigger");
    // The real kinds, spelled as `lib/automations/types.ts` stores them — a fixture with an
    // invented `kind` agrees with itself and proves nothing about the writer.
    expect(
      f({
        kind: "charge-session",
        source: { kind: "derivation", derivationId: "d1" },
      }),
    ).toEqual(["d1"]);
    expect(
      f({ kind: "charge-session", source: { kind: "point", pointId: "p1" } }),
    ).toEqual(["p1"]);
    // The `exercise` trigger's load point — the reference a hand-kept list did not have.
    expect(
      f({
        kind: "exercise",
        source: { kind: "derivation", derivationId: "d1" },
        unless: { loadPointId: "p2", minLoadKw: 1.5 },
      }),
    ).toEqual(["d1", "p2"]);
  });

  it("finds every slot of a derivation's source points", () => {
    const f = extractor("derivations", "source_points");
    expect(f({ signal: "s", energy: null, boundary: "b" }).sort()).toEqual([
      "b",
      "s",
    ]);
    expect(f({ power: "p" })).toEqual(["p"]);
  });

  it("finds a dashboard doc's area and device refs at any depth", () => {
    const f = extractor("dashboards", "doc");
    const doc = {
      version: 4,
      children: [
        { area: "ar_01aaaaaaaaaaaaaaaaaaaaaaaa", children: [] },
        { children: [{ device: "dv_01bbbbbbbbbbbbbbbbbbbbbbbb" }] },
        { label: "ar_not_a_real_id" },
      ],
    };
    expect(f(doc).sort()).toEqual([
      "ar_01aaaaaaaaaaaaaaaaaaaaaaaa",
      "dv_01bbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });
});

describe("the census sees every table in the schema", () => {
  it("covers all of them, so a new table cannot be invisible", () => {
    const tables = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((v) => getTableConfig(v as never).name);
    expect(tables.length).toBeGreaterThanOrEqual(24);
    const censused = new Set(referenceCandidates().map((c) => c.table));
    // Not every table HAS a reference column, so this is a sanity check on the walk rather than a
    // completeness claim: the tables with no candidate at all should be a short, boring list.
    const withNone = tables.filter((t) => !censused.has(t)).sort();
    expect(withNone).toEqual([]);
  });
});

describe("the census cannot become an access path", () => {
  /**
   * 🛑 This test is what pays for `lib/integrity/ledger.ts`'s exemption in
   * `scripts/check-readings-boundary.mjs`. The census must name every table in the schema —
   * including the three hot time-series tables the readings seam walls off — so it is exempted from
   * that guard. The exemption is only defensible while the module physically cannot query anything.
   *
   * If this assertion is deleted, the exemption must be deleted with it.
   */
  it("imports no database client and builds no queries", () => {
    const src = readFileSync(join(__dirname, "..", "ledger.ts"), "utf8");

    // Naming a client. Covers the import and any re-derivation of one.
    for (const forbidden of [
      "requirePlanetscaleDb",
      "planetscaleDb",
      'lib/db/planetscale"',
      "drizzle-orm/pg-core/query-builders",
    ])
      expect(
        src.includes(forbidden)
          ? `ledger.ts references ${forbidden} — it must stay introspection-only`
          : "ok",
      ).toBe("ok");

    // 🛑 And the query-builder verbs, because naming a client is not the only way to use one. The
    // first version of this test checked the four strings above and nothing else, which a review
    // pointed out is evaded by a single line that takes the client as an argument:
    //
    //     export const readHot = (db: any) => db.select().from(pointReadings);
    //
    // That is the exact shape the exemption must not permit, so it is checked directly.
    for (const verb of [
      ".select(",
      ".from(",
      ".insert(",
      ".update(",
      ".delete(",
      ".execute(",
      ".transaction(",
    ])
      expect(
        src.includes(verb)
          ? `ledger.ts calls ${verb} — a census describes the schema, it does not query it`
          : "ok",
      ).toBe("ok");
  });
});
