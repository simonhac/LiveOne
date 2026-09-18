/**
 * The Select.live Events page — the PORTAL's view of this system's faults.
 *
 * Three different things record a Selectronic fault, and none of them substitutes for another:
 *
 * | Source | What it gives | Clock |
 * | --- | --- | --- |
 * | `/dashboard/hfdata/{id}` (the minutely poll) | `fault_code` / `fault_ts` — the CURRENT fault, if any | vendor Unix seconds |
 * | `/events/{id}` (here) | a retained list, with **paired Created/Cleared** times | the portal account's timezone |
 * | The inverter's own logs (lib/selectlive/events.ts) | every fault AND state change, with an electrical snapshot | the inverter's own clock |
 *
 * 🛑 The reason this file exists: across the 17–18 September 2026 Daylesford interruptions, every
 * one of 126 successful `hfdata` samples carried `fault_code: 0`, while this page retained a
 * "Unit - Instant Low DC Voltage Fault" for each of the two blackouts. A fresh zero from the poll
 * is NOT evidence that nothing happened — it is a sample of an instant, and the faults here
 * outlived every instant we sampled.
 *
 * The page renders its rows server-side; there is no separate JSON endpoint (the search box filters
 * the rendered table client-side). So this is HTML parsing, with the failure modes HTML parsing
 * has — and the rule throughout is that an unrecognisable page is UNAVAILABLE DATA, never an empty
 * event history. An empty history would clear a fault that is still active.
 */
import * as cheerio from "cheerio";
import { parseDateTime, toZoned } from "@internationalized/date";
import type { SelectronicFetchClient } from "./selectronic-client";

/** Portal-only communications event: "no updates for more than 24 hours". It describes OUR link to
 * the portal, not the inverter's state, so it never counts as an inverter fault and never triggers
 * a diagnostic acquisition. */
export const PORTAL_COMMS_EVENT_CODE = 1001;

export interface PortalEvent {
  code: number;
  description: string;
  /** Verbatim from the page, e.g. "2026-09-17 19:53:00". Preserved even when unparseable. */
  createdText: string;
  /** Verbatim; empty string when the page shows no clearance. */
  clearedText: string;
  /** UTC, when `createdText` is unambiguous in `timezone`. Null otherwise — never guessed. */
  createdAt: Date | null;
  clearedAt: Date | null;
  /** No clearance time on the page. This — not the row's icon — is what "still active" means here. */
  active: boolean;
  /** The row's status glyph classes, kept because they are the portal's own claim about the row and
   * we have only ever observed the cleared variant. A disagreement with `active` is reported, not
   * resolved. */
  statusClass: string;
  /** Set when the glyph says cleared but no clearance time was supplied, or vice versa. */
  statusInconsistent: boolean;
  /** Stable identity for deduplicating across polls. A row's Created time is its occurrence. */
  dedupeKey: string;
}

export type PortalEventsResult =
  | {
      available: true;
      events: PortalEvent[];
      timezone: string;
      fetchedAt: Date;
      /** Rows the page rendered that we could not read. Non-zero means the parse is partial. */
      unreadableRows: number;
    }
  | { available: false; reason: string; fetchedAt: Date };

const BASE_URL = "https://select.live";
/** Bounded independently of the readings request: the Events page must never be able to eat the
 * minutely poll's budget, and a slow page is not a reason to lose the readings. */
const PORTAL_EVENTS_TIMEOUT_MS = 8000;

const looksLikeLogin = (html: string) =>
  /name=["']password["']/i.test(html) ||
  /<form[^>]+action=["']\/login/i.test(html);

/**
 * Interpret a portal timestamp in the account's timezone.
 *
 * `reject` on DST ambiguity: an April 06:30 in Melbourne exists twice, and silently picking one
 * would put a fault an hour away from where it happened. A null here is honest; the verbatim text
 * is retained either way.
 */
export function portalTimestamp(text: string, timezone: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  try {
    return toZoned(
      parseDateTime(
        `${match[1]}T${match[2].length === 5 ? `${match[2]}:00` : match[2]}`,
      ),
      timezone,
      "reject",
    ).toDate();
  } catch {
    return null;
  }
}

export function parsePortalEvents(
  html: string,
  timezone: string,
): { events: PortalEvent[]; unreadableRows: number } | { error: string } {
  if (looksLikeLogin(html))
    return {
      error:
        "Select.live returned the login page for the Events request; the session is not authenticated.",
    };
  const $ = cheerio.load(html);
  const table = $("table").filter((_, el) => {
    const headers = $(el)
      .find("thead th")
      .map((__, th) => $(th).text().trim().toLowerCase())
      .get();
    return headers.includes("code") && headers.includes("created");
  });
  if (table.length === 0)
    return {
      error:
        "The Events page did not contain a recognisable events table; treating event history as unavailable.",
    };
  const events: PortalEvent[] = [];
  let unreadableRows = 0;
  table
    .first()
    .find("tbody tr")
    .each((_, row) => {
      const cells = $(row)
        .find("td")
        .map((__, td) => $(td).text().trim())
        .get();
      if (cells.length < 5) {
        unreadableRows++;
        return;
      }
      const code = Number(cells[1]);
      if (!Number.isInteger(code)) {
        unreadableRows++;
        return;
      }
      const createdText = cells[3];
      const clearedText = cells[4];
      const statusClass =
        $(row).find("td").first().find("span").attr("class")?.trim() ?? "";
      const active = clearedText === "";
      events.push({
        code,
        description: cells[2],
        createdText,
        clearedText,
        createdAt: portalTimestamp(createdText, timezone),
        clearedAt: portalTimestamp(clearedText, timezone),
        active,
        statusClass,
        statusInconsistent: active && /ok-sign|color-green/.test(statusClass),
        dedupeKey: `p:${code}:${createdText}`,
      });
    });
  return { events, unreadableRows };
}

/** The portal account's timezone, from /myprofile. Falls back to the caller's default rather than
 * to UTC: every timestamp on the Events page is in this zone, and assuming UTC would shift every
 * fault by hours without anything looking wrong. */
export async function fetchAccountTimezone(
  client: SelectronicFetchClient,
  fallback: string,
): Promise<string> {
  try {
    const response = await fetch(`${BASE_URL}/myprofile`, {
      headers: {
        Cookie: client.getCookieString(),
        "User-Agent": "LiveOne/1.0",
      },
      signal: AbortSignal.timeout(PORTAL_EVENTS_TIMEOUT_MS),
    });
    if (!response.ok) return fallback;
    const html = await response.text();
    if (looksLikeLogin(html)) return fallback;
    const $ = cheerio.load(html);
    const selected = $("select[name*='zone' i] option[selected]")
      .first()
      .text()
      .trim();
    const candidate =
      selected ||
      $("select[name*='zone' i]").first().val()?.toString().trim() ||
      "";
    if (!candidate) return fallback;
    try {
      new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
      return candidate;
    } catch {
      return fallback;
    }
  } catch {
    return fallback;
  }
}

export async function fetchPortalEvents(
  client: SelectronicFetchClient,
  systemNumber: string,
  timezone: string,
): Promise<PortalEventsResult> {
  const fetchedAt = new Date();
  try {
    const response = await fetch(`${BASE_URL}/events/${systemNumber}`, {
      headers: {
        Cookie: client.getCookieString(),
        "User-Agent": "LiveOne/1.0",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(PORTAL_EVENTS_TIMEOUT_MS),
    });
    if (!response.ok)
      return {
        available: false,
        reason: `HTTP ${response.status} from the Events page.`,
        fetchedAt,
      };
    const parsed = parsePortalEvents(await response.text(), timezone);
    if ("error" in parsed)
      return { available: false, reason: parsed.error, fetchedAt };
    return {
      available: true,
      events: parsed.events,
      timezone,
      fetchedAt,
      unreadableRows: parsed.unreadableRows,
    };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? `Events request failed: ${error.message}`
          : "Events request failed.",
      fetchedAt,
    };
  }
}

/** Inverter faults only — the portal's own communications events describe our link, not the plant. */
export const isInverterEvent = (event: PortalEvent) =>
  event.code !== PORTAL_COMMS_EVENT_CODE;

/**
 * The portal's answer to "is a fault active right now, and when did the most recent one START?".
 *
 * `lastFaultAt` is deliberately the newest **Created** across all inverter events, active or not —
 * it is the sticky "last fault time", so it survives clearance. Cleared is never used for it: a
 * clearance is when the fault ENDED.
 */
export function summarisePortalEvents(events: PortalEvent[]): {
  activeCode: number | null;
  activeSince: Date | null;
  lastFaultAt: Date | null;
} {
  const inverterEvents = events.filter(isInverterEvent);
  const byCreated = [...inverterEvents].sort((a, b) =>
    b.createdText.localeCompare(a.createdText),
  );
  const active = byCreated.find((e) => e.active) ?? null;
  return {
    activeCode: active?.code ?? null,
    activeSince: active?.createdAt ?? null,
    lastFaultAt: byCreated[0]?.createdAt ?? null,
  };
}
