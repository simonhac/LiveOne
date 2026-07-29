/**
 * Slice-K1 parity gate — the evidence that makes slice K2's 89-call-site conversion safe rather than a
 * leap of faith. Read-only; safe against any environment.
 *
 *   npx tsx --env-file=.env.local scripts/config-v4/verify-slice-k1-parity.ts
 *
 * Four blocks:
 *
 * 1. **Field-by-field**, over EVERY handle (`systems.id` ∪ `devices.rid`, so a row present on only one
 *    side is a failure rather than an absence): `SystemsManager.getSystem(h)` vs
 *    `DeviceConfigRegistry.deviceByHandle(h)`. Drives the real code paths, not a re-derivation in SQL,
 *    so a mistake in the new module is caught and not just a data mismatch. The three spec columns are
 *    excluded — `devices` has no counterpart by design, and block 3 covers them.
 *
 * 2. **Polling state.** `getSystem` reaches `device_state` through the `deviceStateByHandle` subquery
 *    (re-keying it onto the handle via `devices.rid`); the new read joins `device_state` on
 *    `devices.id` NATIVELY. Two different routes to the same row, so they are compared as a whole
 *    object — this is the check that says the subquery can be DELETED, not moved.
 *
 * 3. **maxPowerHint** — the only BEHAVIOURAL consumer of the free-text spec columns
 *    (`maxPowerHintFromSystemInfo` → the line chart's y-axis, `components/dashboard/cards/chart.tsx`).
 *    Old = the retiring regex over `systems`; new = `maxPowerHintFromSpec` over `devices.config.spec`.
 *    ⚠️ NOT a 0-differences assertion: it is 0 differences EXCEPT the named entries in
 *    `EXPECTED_HINT_CHANGES` below, each of which must be present AND match exactly. A gate that
 *    reports "0 differences" after quietly widening what counts as no difference is worse than no gate,
 *    so an unlisted divergence AND an unfired expectation both fail.
 *
 * 4. **The mint-not-edit leak.** `SystemsManager.updateSystem` re-mirrors `devices` but NEVER re-copies
 *    `location` / `timezone_offset_min` / `display_timezone` to the area-of-one, which
 *    `ensureAreaOfOne` only ever wrote at MINT. Since `DeviceRecord` sources all three from the AREA,
 *    any drift is a live defect that K2 would turn into wrong served config. This block measures it.
 */
import { sql } from "drizzle-orm";
import { planetscaleDb } from "@/lib/db/planetscale";
import { SystemsManager, type SystemWithPolling } from "@/lib/systems-manager";
import { DeviceConfigRegistry, type DeviceRecord } from "@/lib/registry";
import { maxPowerHintFromSpec } from "@/lib/capabilities/config";
import { maxPowerHintFromSystemInfo } from "@/components/dashboard/cards/shared";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

const db = planetscaleDb!;
const sm = SystemsManager.getInstance();

/**
 * The ONLY permitted `maxPowerHint` divergences, by legacy handle. Each must fire exactly as stated.
 *
 * Handle 13 / Kutis (Sigenergy): `solar_size` is "11.9kW" with no space, which the retiring regex's
 * `\s+` requirement rejected — so this chart has had NO y-axis hint at all. Simon's ruling: take the
 * correct value, don't reproduce the bug. Its y-axis will visibly change, from data-derived autoscale to
 * an 11.9 kW hint.
 */
const EXPECTED_HINT_CHANGES: Record<
  number,
  { name: string; old: number | undefined; new: number | undefined }
> = {
  13: { name: "Kutis", old: undefined, new: 11.9 },
};

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  FAIL ${msg}`);
};

/** Fields compared verbatim. The three spec columns are absent from `DeviceRecord` by design. */
const FIELDS = [
  "id",
  "ownerClerkUserId",
  "vendorType",
  "vendorSiteId",
  "status",
  "displayName",
  "alias",
  "model",
  "serial",
  // `location` is NOT here — it has its own directional block (4). It is the one field whose two
  // sources are legitimately allowed to disagree in ONE direction, and a symmetric equality check
  // cannot express that.
  "metadata",
  "config",
  "timezoneOffsetMin",
  "displayTimezone",
  "createdAt",
  "updatedAt",
  "commissionedOn",
] as const;

/**
 * `config` needs its own comparison: `devices.config` legitimately carries `spec`, which
 * `systems.config` does not (that is the whole point of this slice). Everything else must be identical.
 */
function configsAgree(a: unknown, b: unknown): boolean {
  const strip = (o: unknown) => {
    if (o == null || typeof o !== "object") return o ?? null;
    const {
      spec: _s,
      legacyRatings: _r,
      legacySolarSize: _ss,
      legacyBatterySize: _bs,
      ...rest
    } = o as Record<string, unknown>;
    return Object.keys(rest).length === 0 ? null : rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

const norm = (v: unknown) =>
  v instanceof Date ? v.toISOString() : JSON.stringify(v ?? null);

async function main() {
  // Every handle either side knows about. A union, not `systems` alone: a `devices` row with no
  // `systems` counterpart is exactly the divergence this gate exists to refuse to miss.
  const { rows: handleRows } = (await db.execute(sql`
    SELECT rid AS handle FROM devices
    UNION
    SELECT id  AS handle FROM systems
    ORDER BY handle`)) as unknown as { rows: { handle: number }[] };
  const handles = handleRows.map((r) => r.handle);

  // ---- Blocks 1 + 2: field-by-field, and polling state -------------------------------------------
  let compared = 0;
  let fieldChecks = 0;
  const oldByHandle = new Map<number, SystemWithPolling>();
  const newByHandle = new Map<number, DeviceRecord>();

  for (const h of handles) {
    const [oldRec, newRec] = await Promise.all([
      sm.getSystem(h),
      DeviceConfigRegistry.deviceByHandle(h),
    ]);
    if (!oldRec || !newRec) {
      fail(
        `handle ${h}: getSystem=${oldRec ? "row" : "null"} deviceByHandle=${newRec ? "row" : "null"}`,
      );
      continue;
    }
    oldByHandle.set(h, oldRec);
    newByHandle.set(h, newRec);
    compared++;

    for (const f of FIELDS) {
      fieldChecks++;
      const a = (oldRec as Record<string, unknown>)[f];
      const b = (newRec as unknown as Record<string, unknown>)[f];
      const agree = f === "config" ? configsAgree(a, b) : norm(a) === norm(b);
      if (!agree)
        fail(
          `handle ${h} (${oldRec.displayName}) .${f}: old=${norm(a)} new=${norm(b)}`,
        );
    }

    // Block 2 — the whole device_state row, both routes.
    fieldChecks++;
    if (
      JSON.stringify(oldRec.pollingStatus ?? null) !==
      JSON.stringify(newRec.pollingStatus ?? null)
    )
      fail(
        `handle ${h} (${oldRec.displayName}) .pollingStatus differs between subquery and native join`,
      );
  }
  console.log(
    `\nBlock 1+2 — ${compared}/${handles.length} handles compared, ${fieldChecks} field checks`,
  );

  // ---- Block 3: maxPowerHint, with named expected changes ----------------------------------------
  const fired = new Set<number>();
  let hintChecks = 0;
  for (const h of handles) {
    const oldRec = oldByHandle.get(h);
    const newRec = newByHandle.get(h);
    if (!oldRec || !newRec) continue;
    hintChecks++;
    const oldHint = maxPowerHintFromSystemInfo({
      solarSize: oldRec.solarSize ?? undefined,
      ratings: oldRec.ratings ?? undefined,
    });
    const newHint = maxPowerHintFromSpec(newRec.config?.spec);
    if (oldHint === newHint) continue;

    const expected = EXPECTED_HINT_CHANGES[h];
    if (!expected) {
      fail(
        `handle ${h} (${oldRec.displayName}) maxPowerHint UNEXPECTEDLY moved: ${oldHint} -> ${newHint}` +
          ` (solar_size=${JSON.stringify(oldRec.solarSize)} ratings=${JSON.stringify(oldRec.ratings)})`,
      );
      continue;
    }
    if (expected.old !== oldHint || expected.new !== newHint) {
      fail(
        `handle ${h} (${oldRec.displayName}) expected maxPowerHint ${expected.old} -> ${expected.new},` +
          ` got ${oldHint} -> ${newHint}`,
      );
      continue;
    }
    fired.add(h);
    console.log(
      `  EXPECTED CHANGE handle ${h} (${expected.name}): maxPowerHint ${oldHint} -> ${newHint}` +
        `  [solar_size=${JSON.stringify(oldRec.solarSize)} — the retiring regex required a space]`,
    );
  }
  for (const [h, e] of Object.entries(EXPECTED_HINT_CHANGES)) {
    if (!fired.has(Number(h)))
      fail(
        `expected maxPowerHint change for handle ${h} (${e.name}) did NOT fire — the expectation is stale`,
      );
  }
  console.log(
    `Block 3 — ${hintChecks} maxPowerHint checks, ${fired.size}/${Object.keys(EXPECTED_HINT_CHANGES).length} expected changes fired`,
  );

  // ---- Block 4: the mint-not-edit leak (systems placement vs the area-of-one) --------------------
  //
  // DIRECTIONAL, on purpose. `location`/tz have TWO homes today and the clean-sheet designates the
  // area-of-one as the sole one, so the two directions do not mean the same thing:
  //
  //   • area NULL / systems set, or both set and different  → **FAIL**. `DeviceRecord` serves the AREA,
  //     so K2 would start serving null (or a stale value) where the app serves a real location today.
  //     That is a loss, and it is what `ensureAreaOfOne`'s mint-only write leaves behind.
  //   • systems NULL / area set                             → **expected**. The area is the authority;
  //     a `systems` column that never caught up is precisely what Phase 12 retires.
  //
  // This is a directional rule, not a widened tolerance: the failing direction still fails.
  const { rows: drift } = (await db.execute(sql`
    SELECT s.id, s.display_name,
           s.timezone_offset_min AS s_tz_off, a.timezone_offset_min AS a_tz_off,
           s.display_timezone    AS s_tz,     a.display_timezone    AS a_tz,
           s.location::text      AS s_loc,    a.location::text      AS a_loc
      FROM systems s
      JOIN devices d ON d.rid = s.id
      JOIN areas   a ON a.id  = d.primary_area_id
     WHERE s.timezone_offset_min IS DISTINCT FROM a.timezone_offset_min
        OR s.display_timezone    IS DISTINCT FROM a.display_timezone
        OR coalesce(s.location, 'null'::jsonb) IS DISTINCT FROM coalesce(a.location, 'null'::jsonb)
     ORDER BY s.id`)) as unknown as {
    rows: {
      id: number;
      display_name: string;
      s_loc: string | null;
      a_loc: string | null;
      s_tz_off: number;
      a_tz_off: number;
      s_tz: string;
      a_tz: string;
    }[];
  };
  let losing = 0;
  let benign = 0;
  for (const r of drift) {
    const tzDrift = r.s_tz_off !== r.a_tz_off || r.s_tz !== r.a_tz;
    // Every row here already differs as JSONB (the WHERE used `IS DISTINCT FROM`, so key-order noise
    // from `::text` cannot reach us). So "systems holds a value" is exactly "the area is null or stale".
    const areaLoses = r.s_loc != null;
    if (tzDrift || areaLoses) {
      losing++;
      fail(
        `handle ${r.id} (${r.display_name}) placement: the AREA is behind/absent —` +
          ` systems.location=${r.s_loc} area.location=${r.a_loc}` +
          (tzDrift
            ? ` systems.tz=${r.s_tz_off}/${r.s_tz} area.tz=${r.a_tz_off}/${r.a_tz}`
            : ""),
      );
    } else {
      benign++;
      console.log(
        `  EXPECTED handle ${r.id} (${r.display_name}): systems.location is stale/null,` +
          ` the area holds ${r.a_loc} — the area is the authority`,
      );
    }
  }
  console.log(
    `Block 4 — placement drift: ${drift.length} device(s) — ${losing} losing, ${benign} benign`,
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${handles.length} handles, ${fieldChecks + hintChecks} checks, ${failures} divergence(s)\n`,
  );
  if (failures > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
