/** Error thrown by the query fetchers when a response is not ok, so React Query
 *  surfaces it as `isError` with the status available for the UI to branch on. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public statusText: string,
  ) {
    super(`HTTP ${status} ${statusText}`);
    this.name = "HttpError";
  }
}

/**
 * Propagate a dashboard share token (P4): in the browser, when the current page URL carries
 * `?access=<token>` (a shared, read-only dashboard view), append it to same-origin `/api/` requests so
 * the query is authorized by `requireDashboardAccess`. No-op on the server, for non-`/api/` URLs, when
 * no token is present, or when the URL already carries one. Normal authed views (no `?access=`) are
 * unaffected.
 */
function withAccessToken(url: string): string {
  if (typeof window === "undefined") return url;
  if (!url.startsWith("/api/") || /[?&]access=/.test(url)) return url;
  const token = new URLSearchParams(window.location.search).get("access");
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access=${encodeURIComponent(token)}`;
}

/** fetch + ok-check + plain JSON parse (timestamps stay as ISO strings; convert at the
 *  consumer or via a query `select`). */
export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(withAccessToken(url), { credentials: "same-origin" });
  if (!res.ok) throw new HttpError(res.status, res.statusText);
  return res.json() as Promise<T>;
}
