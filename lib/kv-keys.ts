/**
 * The SINGLE OWNER of every KV key string in the latest-values / subscriptions / system-summaries /
 * OE-scheduler families.
 *
 * ## Why this module exists
 *
 * Before it, there were **four key-builder definitions across three files for two key families**:
 *
 * ```
 * lib/kv-cache-manager.ts     latest:system:${systemId}
 * lib/kv-cache-manager.ts     subscriptions:system:${systemId}
 * lib/latest-values-store.ts  latest:system:${systemId}          ← duplicate
 * lib/system-summary-store.ts subscriptions:system:${systemId}   ← duplicate
 * ```
 *
 * A duplicated key builder is a **silent cache split** waiting to happen: change one and miss the
 * other and writes land under the new key while reads come from the old. Nothing errors — the symptom
 * is an empty `latest` map on a dashboard, which looks like "no data yet". `tsc` cannot see it, because
 * both sides still compile and both still return a `string`.
 *
 * So: no module outside this one may build a KV key for these families by string interpolation. If you
 * need a new shape, add it here.
 */
import { kvKey } from "./kv";

// ── latest values (Redis Hash: logicalPath → LatestValue) ────────────────────────────────────────

/** The per-system latest-values hash. */
export function latestValuesKey(systemId: number): string {
  return kvKey(`latest:system:${systemId}`);
}

/** SCAN/KEYS pattern covering every latest-values hash in this environment. */
export function latestValuesKeyPattern(): string {
  return kvKey("latest:system:*");
}

// ── subscription registry (Redis JSON: sourcePointUid → subscriberRefs) ──────────────────────────

/** The per-source-system subscription-registry entry. */
export function subscriptionsKey(systemId: number): string {
  return kvKey(`subscriptions:system:${systemId}`);
}

/** SCAN/KEYS pattern covering every subscription-registry entry in this environment. */
export function subscriptionsKeyPattern(): string {
  return kvKey("subscriptions:system:*");
}

// ── system summaries (ONE Redis Hash for the whole environment, field = system id) ────────────────

/** The single environment-wide summaries hash. */
export function summariesKey(): string {
  return kvKey("system-summaries");
}

/** The hash FIELD naming one system inside {@link summariesKey}. */
export function summariesField(systemId: number): string {
  return String(systemId);
}

// ── OpenElectricity poll-scheduler EWMA state (Redis JSON) ───────────────────────────────────────

/** Per-system OE arrival-delay scheduler state. */
export function oeSchedulerStateKey(systemId: number): string {
  return kvKey(`oe:sched:system:${systemId}`);
}
