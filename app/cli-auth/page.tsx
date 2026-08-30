/**
 * /cli-auth — the approval page for the CLI browser hand-off.
 *
 * Clerk-gated by the middleware (it is not in publicRoutes), which is doing real work: a signed-out
 * visitor gets Clerk's sign-in redirect for free, and the code this page mints is bound to whoever
 * comes back. That binding is the entire security story of the flow.
 *
 * The CLI opens this with `?challenge=&state=&port=&label=`. On approval the page POSTs to
 * /api/cli-auth/authorize (session-authenticated) and then hands the code to the CLI, either by
 * redirecting to its loopback listener or — with no `port`, e.g. over SSH — by displaying it to
 * copy. The verifier itself never reaches the browser, so what is on screen here is not sufficient
 * to mint a token.
 */
"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";

export default function CliAuthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  return <CliAuth searchParams={searchParams} />;
}

function CliAuth({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { user, isLoaded } = useUser();
  const [params, setParams] = useState<Record<string, string | undefined>>();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "code"; code: string }
    | { kind: "error"; message: string }
    | { kind: "denied" }
  >({ kind: "idle" });

  if (!params) {
    void searchParams.then(setParams);
    return <Shell>Loading…</Shell>;
  }
  if (!isLoaded) return <Shell>Loading…</Shell>;

  const challenge = params.challenge ?? "";
  const label = params.label ?? "cli";
  const port = params.port;
  const cliState = params.state ?? "";

  if (!challenge)
    return (
      <Shell>
        <p className="text-red-600">
          This link is missing its challenge. Re-run{" "}
          <code>npm run dashboard -- auth login</code> and use the URL it
          prints.
        </p>
      </Shell>
    );

  async function approve() {
    setState({ kind: "working" });
    try {
      const res = await fetch("/api/cli-auth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge, label }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: "error",
          message: body.error ?? `authorize failed (${res.status})`,
        });
        return;
      }
      const { code } = (await res.json()) as { code: string };
      if (port) {
        // The RFC 8252 loopback leg. `state` goes back so the CLI can prove this callback answers
        // the request it made — a hostile page that guessed the port cannot produce it.
        window.location.href = `http://127.0.0.1:${encodeURIComponent(
          port,
        )}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(cliState)}`;
        return;
      }
      setState({ kind: "code", code });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "network error",
      });
    }
  }

  if (state.kind === "denied")
    return <Shell>Denied. Nothing was issued; you can close this tab.</Shell>;

  if (state.kind === "code")
    return (
      <Shell>
        <p className="mb-2">Paste this back into the waiting CLI:</p>
        <code className="block break-all rounded bg-neutral-100 p-3 text-sm dark:bg-neutral-800">
          {state.code}
        </code>
        <p className="mt-3 text-sm text-neutral-500">
          It expires in five minutes, and is useless on its own — the CLI also
          needs the verifier it kept.
        </p>
      </Shell>
    );

  return (
    <Shell>
      <p className="mb-4">
        Sign in the LiveOne CLI on <strong>{label}</strong>?
      </p>
      <p className="mb-4 text-sm text-neutral-500">
        You are <strong>{user?.primaryEmailAddress?.emailAddress}</strong>. The
        CLI will act as you, and you can revoke it at any time with{" "}
        <code>auth revoke</code>.
      </p>
      {state.kind === "error" && (
        <p className="mb-3 text-red-600">{state.message}</p>
      )}
      <div className="flex gap-3">
        <button
          onClick={approve}
          disabled={state.kind === "working"}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {state.kind === "working" ? "Authorising…" : "Approve"}
        </button>
        <button
          onClick={() => setState({ kind: "denied" })}
          className="rounded border px-4 py-2"
        >
          Deny
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="mb-4 text-xl font-semibold">LiveOne CLI</h1>
      {children}
    </main>
  );
}
