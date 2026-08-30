/**
 * The CLI's HTTP client for the deployed LiveOne API — one fetch wrapper, one error vocabulary.
 *
 * Every non-2xx maps to a `CliFailure` whose what/why/next is written for the operator holding the
 * terminal, because over HTTP the raw status codes are systematically ambiguous:
 *   - a 404 can mean "no such dashboard" OR "the edge middleware rejected the credential and
 *     rewrote the request before the handler ever saw it" — `x-clerk-auth-reason: protect-rewrite`
 *     is the only discriminator;
 *   - a 307 means the caller hit the apex host, and following it would STRIP the Authorization
 *     header (undici drops auth on cross-origin redirects), surfacing later as a baffling 401 — so
 *     redirects are never followed, they are named;
 *   - a 403 on a doc write usually means `checkDocRefsReadable` refused a ref, and the sanctioned
 *     escape hatch for repairing such a doc is the db transport, which the message says.
 *
 * `fetchImpl` is injectable so every branch is unit-testable without a network.
 */
import { EXIT, failWith } from "@/lib/cli/cli";
import type { DocIssue } from "@/lib/dashboard/v4-validate";

export interface ApiInit {
  method?: string;
  body?: unknown;
  /** Sent as `If-Match: "<n>"` — the PUT's optimistic-concurrency token. */
  ifMatch?: number;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface ApiOk<T> {
  status: number;
  body: T;
  /** The unquoted ETag revision, when the server sent one. */
  etagRevision?: number;
}

/** 422 bodies carry structured issues; the caller renders them through printIssues. */
export interface ValidationRejection {
  errors: DocIssue[];
  warnings: DocIssue[];
}

export class DocInvalidError extends Error {
  constructor(readonly rejection: ValidationRejection) {
    super("the document was rejected by the server's validator");
    this.name = "DocInvalidError";
  }
}

export async function apiFetch<T = Record<string, unknown>>(
  origin: string,
  path: string,
  init: ApiInit = {},
): Promise<ApiOk<T>> {
  const f = init.fetchImpl ?? fetch;
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.ifMatch !== undefined) headers["if-match"] = `"${init.ifMatch}"`;

  let res: Response;
  try {
    res = await f(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
  } catch (err) {
    throw failWith(
      EXIT.UPSTREAM,
      `${origin} is unreachable`,
      err instanceof Error ? err.message : String(err),
      "check the origin (and that a dev server is running, for localhost)",
    );
  }

  if (res.status >= 300 && res.status < 400)
    throw failWith(
      EXIT.USAGE,
      `${origin} redirects (${res.status})`,
      "auth headers do not survive a cross-origin redirect, so it is refused rather than followed",
      "use the canonical host — https://www.liveone.energy, not the apex",
    );

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.ok) {
    const etag = res.headers.get("etag");
    const m = etag ? /^"(\d+)"$/.exec(etag) : null;
    return {
      status: res.status,
      body: body as T,
      etagRevision: m ? Number(m[1]) : undefined,
    };
  }

  const serverError = typeof body.error === "string" ? body.error : undefined;
  switch (res.status) {
    case 401:
      throw failWith(
        EXIT.AUTH,
        `not authenticated to ${origin}`,
        "there is no valid CLI token for this origin (missing, expired or revoked)",
        `run \`liveone auth login --base-url=${origin}\``,
      );
    case 403:
      throw failWith(
        EXIT.FINDINGS,
        serverError ?? "forbidden",
        "the server refused this operation for this user",
        "a doc whose refs the owner cannot read can only be repaired with --via=db",
      );
    case 404:
      if (res.headers.get("x-clerk-auth-reason") === "protect-rewrite")
        throw failWith(
          EXIT.AUTH,
          `${origin} rejected the CLI credential at the edge`,
          "the middleware 404-rewrote the request before the handler saw it — this deployment may predate CLI tokens",
          "check the deployed build; `liveone auth whoami` shows its sha",
        );
      throw failWith(
        EXIT.FINDINGS,
        serverError ?? `not found: ${path}`,
        "nothing at that address for this user",
        "run `liveone dashboard list` — ids are per-environment",
      );
    case 409:
      throw failWith(
        EXIT.FINDINGS,
        serverError ?? "conflict",
        "the value collides with something that already exists",
        "pick a different slug",
      );
    case 412:
      throw failWith(
        EXIT.FINDINGS,
        "revision conflict",
        `the dashboard changed under us (server is now at revision ${body.current ?? "?"})`,
        "re-run the command — it re-reads before writing",
      );
    case 422:
      throw new DocInvalidError({
        errors: (body.errors as DocIssue[]) ?? [],
        warnings: (body.warnings as DocIssue[]) ?? [],
      });
    case 503:
      throw failWith(
        EXIT.UPSTREAM,
        `${origin} answered 503`,
        serverError ?? "the deployment is not configured for this operation",
        "if this is cli-auth: set CLI_AUTH_SIGNING_SECRET and redeploy",
      );
    default:
      throw failWith(
        EXIT.UPSTREAM,
        `${origin}${path} answered ${res.status}`,
        serverError ?? "unexpected server error",
        "retry; if it persists the deployment is degraded — check Vercel logs",
      );
  }
}
