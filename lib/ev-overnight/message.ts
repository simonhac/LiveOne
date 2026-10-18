/**
 * EV-overnight advisor — the text message. Pure render; sending is `notify.ts`'s problem.
 *
 * `send: false` for "no action needed": that advice is worth logging, not worth a text.
 */
import type { Advice } from "./advisor";

/** `10:35pm` in `tz`. */
export function clockTime(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(ms)
    .replace(/\s/g, "")
    .toLowerCase();
}

const pct = (x: number) => `${Math.round(x)}%`;
const kwh = (x: number) => `${x < 10 ? x.toFixed(1) : Math.round(x)} kWh`;

/** Stops this close to "now" are phrased as "now" — the text would arrive after the time it names. */
const IMMINENT_MS = 10 * 60_000;

export function renderAdvice(
  a: Advice,
  tz: string,
): { send: boolean; body: string } {
  const opener = `I notice the car is charging from your home battery. It's at ${pct(a.socPct)}.`;
  const sol = a.solution;
  switch (sol.kind) {
    case "stop-at": {
      const total = a.sessionKwhSoFar + sol.evKwhFromNow;
      const when =
        sol.stopAtMs - a.atMs <= IMMINENT_MS
          ? `in the next few minutes (by ${clockTime(sol.stopAtMs, tz)})`
          : `at ${clockTime(sol.stopAtMs, tz)}`;
      return {
        send: true,
        body:
          `${opener} If you turn off car charging ${when} — or when the home battery gets to ` +
          `${pct(sol.stopSocPct)} — the car will have had ${kwh(total)} and you'll still have enough in ` +
          `the battery to carry the house through to the morning sun.`,
      };
    }
    case "stop-now": {
      const tail =
        sol.shortfallKwh < 0.2
          ? `If you turn off car charging now, there's just enough left to carry the house through to the morning sun.`
          : `If you turn off car charging now, the house should only need about ${kwh(sol.shortfallKwh)} ` +
            `from the grid before the morning sun.`;
      return {
        send: true,
        body:
          `${opener} That's already below the ${pct(sol.requiredSocPct)} the house typically needs to get ` +
          `through the night, and the car has had ${kwh(a.sessionKwhSoFar)} so far. ${tail}`,
      };
    }
    case "battery-empty":
      return {
        send: false,
        body: `${opener} It's already at its floor, so the car and the house are both on the grid now.`,
      };
    case "no-action":
      return {
        send: false,
        body:
          `${opener} That's plenty to cover the car and the house until the morning sun ` +
          `(${clockTime(sol.coverAtMs, tz)}), so no need to stop.`,
      };
  }
}
