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
        .end(
          '<!doctype html><title>LiveOne CLI</title><body style="font-family:system-ui;padding:2rem">Signed in — you can close this tab and return to the terminal.</body>',
        );
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
