/**
 * The CLI side of the browser hand-off — the pieces of `liveone auth login` that are logic rather
 * than orchestration.
 *
 * The flow (server half shipped in #392): generate a `verifier`, send only its sha256
 * (`challenge`) in the URL, open the browser where the operator is already signed in; the approval
 * page mints a signed CODE and hands it back — via a redirect to the loopback listener here, or by
 * the human pasting it. The CLI then exchanges `code + verifier` for a token.
 *
 * PKCE and `state` come from `@/lib/cli-auth/code` — the SERVER'S OWN module — so the two sides
 * cannot drift on how a challenge is derived or how state is compared. That module is pure
 * node:crypto; nothing edge-constrained imports this file.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { challengeFor, stateMatches } from "@/lib/cli-auth/code";
import { EXIT, failWith } from "@/lib/cli/cli";

export { challengeFor, stateMatches };

/** The PKCE verifier — never leaves this process; only its hash travels. */
export const newVerifier = (): string => randomBytes(32).toString("base64url");

/** The loopback CSRF token — a hostile page that guesses the port still cannot produce it. */
export const newState = (): string => randomBytes(16).toString("base64url");

/** The approval-page URL. Omit `port` for the paste flow (SSH, non-mac). */
export function loginUrl(
  origin: string,
  opts: { challenge: string; state: string; port?: number; label: string },
): string {
  const q = new URLSearchParams({
    challenge: opts.challenge,
    state: opts.state,
    label: opts.label,
  });
  if (opts.port !== undefined) q.set("port", String(opts.port));
  return `${origin}/cli-auth?${q.toString()}`;
}

/**
 * The page the browser lands on after the approval redirect. Self-contained (the server dies right
 * after this response, so no external assets), styled to match the app's dark theme.
 */
const SIGNED_IN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LiveOne CLI</title>
<style>
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
         background: #111827; color: #f3f4f6;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { background: #1f2937; border: 1px solid #374151; border-radius: 0.5rem;
          padding: 2.5rem 3rem; max-width: 24rem; text-align: center;
          box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.3); }
  .tick { width: 3rem; height: 3rem; margin: 0 auto 1rem; border-radius: 9999px;
          background: rgb(74 222 128 / 0.1); display: flex; align-items: center; justify-content: center; }
  .brand { font-size: 1.375rem; font-weight: 600; margin: 0 0 0.25rem; }
  .brand span { color: #3b82f6; }
  h1 { font-size: 1.125rem; font-weight: 500; margin: 0 0 0.5rem; }
  p { color: #9ca3af; font-size: 0.875rem; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
<div class="card">
  <div class="tick"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4ade80"
    stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
  <p class="brand">Live<span>One</span></p>
  <h1>Signed in</h1>
  <p>You can close this tab and return to the terminal.</p>
</div>
</body>
</html>`;

export interface CallbackServer {
  port: number;
  /** Resolves with the callback's params; rejects on timeout. */
  result: Promise<{ code: string; state: string }>;
  close(): void;
}

/**
 * An ephemeral listener on `127.0.0.1:0` for the RFC 8252 loopback leg.
 *
 * Answers exactly one `/callback` and closes. Anything else is 404 — this server exists for one
 * redirect and must not become an accidental surface. The timeout matters because the alternative
 * is a CLI that hangs forever on an approval the operator walked away from.
 */
export function awaitCallback(timeoutMs = 180_000): Promise<CallbackServer> {
  return new Promise((resolveServer, rejectServer) => {
    let settle: (v: { code: string; state: string }) => void;
    let fail: (e: unknown) => void;
    const result = new Promise<{ code: string; state: string }>((res, rej) => {
      settle = res;
      fail = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // Without this, undici's kept-alive connection holds the server open past close() —
          // measured as a jest force-exit warning; in real use, a lingering listener.
          connection: "close",
        })
        .end(SIGNED_IN_HTML);
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      settle({
        code: url.searchParams.get("code") ?? "",
        state: url.searchParams.get("state") ?? "",
      });
    });

    const timer = setTimeout(() => {
      server.close();
      server.closeAllConnections?.();
      fail(
        failWith(
          EXIT.AUTH,
          "login timed out",
          `no approval arrived within ${Math.round(timeoutMs / 1000)}s`,
          "re-run `liveone auth login` (or use --no-browser and paste the code)",
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    server.on("error", (e) => {
      clearTimeout(timer);
      rejectServer(e);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        rejectServer(new Error("loopback listener failed to bind"));
        return;
      }
      resolveServer({
        port: addr.port,
        result,
        close: () => {
          clearTimeout(timer);
          server.close();
          server.closeAllConnections?.();
        },
      });
    });
  });
}
