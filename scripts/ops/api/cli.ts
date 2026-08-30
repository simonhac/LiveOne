/**
 * `liveone api` — the sanctioned raw authenticated request.
 *
 * The escape hatch for endpoints no verb covers yet. It exists so the answer to "the CLI has no
 * verb for this" is never "extract the token from the store and curl": this verb rides the same
 * origin resolution, stored `lo_cli_` token, target line, redirect refusal and protect-rewrite
 * diagnosis as every other command — a hand-rolled curl gets none of those, and normalises
 * handling the raw credential.
 *
 * A COMPOSABLE root-level verb (like `find`), mounted by `scripts/ops/liveone.ts`.
 */
import fs from "node:fs";
import { defineCommand, EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { atMostOne, BASE_URL_FLAG, str, usage } from "../shared";

export const apiCommand = defineCommand({
  name: "api",
  summary: "One authenticated request to the deployed API, as you.",
  when:
    "The escape hatch for endpoints no verb covers yet — never extract the CLI token from the\n" +
    "store by hand. Prefer the purpose-built verbs where they exist (`liveone find <what>`).",
  description:
    "GET runs immediately (reads are the default path); any other method is dry-run by default\n" +
    "and needs --apply. The edge only admits CLI tokens on the routes listed in cliTokenRoutes\n" +
    "(lib/route-matchers.ts) — elsewhere this reports the middleware 404 (protect-rewrite) and\n" +
    "that is by design, not a bug. The response body is the output, verbatim.",
  uses: ["api"],
  mutates: true,
  args: [
    {
      name: "path",
      required: true,
      help: "The request path, starting /api/ (query string allowed)",
    },
  ],
  flags: {
    ...BASE_URL_FLAG,
    method: {
      type: "string",
      values: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      default: "GET",
      help: "HTTP method",
    },
    body: {
      type: "string",
      placeholder: "json",
      help: "Request body, inline JSON (non-GET only)",
    },
    bodyFile: {
      type: "string",
      placeholder: "path",
      help: "Request body, from a JSON file (non-GET only)",
    },
  },
  examples: [
    "liveone api /api/cli-auth/whoami",
    "liveone api /api/v4/dashboards --method=POST --body-file=dash.json --apply",
  ],
} satisfies CommandSpec);

/** Parse `--body`/`--body-file` into a JSON value, or undefined when neither was supplied. */
function parseBody(ctx: Ctx): unknown {
  atMostOne(ctx, ["body", "bodyFile"]);
  const inline = str(ctx, "body");
  const file = str(ctx, "bodyFile");
  const raw =
    inline ?? (file !== undefined ? fs.readFileSync(file, "utf8") : undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw usage(
      `--body${inline !== undefined ? "" : "-file"}`,
      `the value is not valid JSON: ${err instanceof Error ? err.message : err}`,
      "pass a JSON document",
    );
  }
}

export async function runApi(ctx: Ctx): Promise<number> {
  const path = ctx.args[0];
  if (!path.startsWith("/api/"))
    throw usage(
      `"${path}"`,
      "this verb only calls the LiveOne API",
      "pass a path starting /api/",
    );
  const method = str(ctx, "method") ?? "GET";
  const body = parseBody(ctx);
  if (body !== undefined && method === "GET")
    throw usage(
      "--body with GET",
      "a GET carries no body",
      "pass --method=POST/PUT/PATCH, or drop the body",
    );

  // GET always runs — reads are what this verb is for, and gating them behind --apply would just
  // push people back to curl. The dry-run/--apply gate protects exactly the non-GET methods.
  if (method !== "GET" && ctx.dryRun) {
    return withApiSession(
      ctx,
      async (s) => {
        ctx.emit(
          {
            origin: s.origin,
            method,
            path,
            body: body ?? null,
            applied: false,
          },
          () =>
            [
              `would ${method} ${s.origin}${path}`,
              ...(body !== undefined ? [JSON.stringify(body, null, 2)] : []),
              "Re-run with --apply to send it.",
            ].join("\n"),
        );
        return EXIT.OK;
      },
      "dry-run",
    );
  }

  return withApiSession(
    ctx,
    async (s) => {
      const { status, body: res } = await apiFetch<unknown>(s.origin, path, {
        method,
        body,
        token: s.token,
        errors: {
          // The default 404 hint is dashboard-flavoured; here the likelier causes are a typo'd
          // path or a route outside the CLI-token edge bypass.
          404: {
            exit: EXIT.FINDINGS,
            what: `not found: ${path}`,
            why: (b) => String(b.error ?? "nothing at that address"),
            next: "check the path — and note the edge only admits CLI tokens on cliTokenRoutes (lib/route-matchers.ts)",
          },
        },
      });
      ctx.note(`${method} ${path} → ${status}`);
      ctx.emit(res, () => JSON.stringify(res, null, 2));
      return EXIT.OK;
    },
    method === "GET" ? "read-only" : "APPLY",
  );
}
