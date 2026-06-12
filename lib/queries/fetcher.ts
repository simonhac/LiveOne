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

/** fetch + ok-check + plain JSON parse (timestamps stay as ISO strings; convert at the
 *  consumer or via a query `select`). */
export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) throw new HttpError(res.status, res.statusText);
  return res.json() as Promise<T>;
}
