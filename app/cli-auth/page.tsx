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
import { Button } from "@/components/ui/button";

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
    return (
      <Shell>
        <p className="text-gray-400">Loading…</p>
      </Shell>
    );
  }
  if (!isLoaded)
    return (
      <Shell>
        <p className="text-gray-400">Loading…</p>
      </Shell>
    );

  const challenge = params.challenge ?? "";
  const label = params.label ?? "cli";
  const port = params.port;
  const cliState = params.state ?? "";

  if (!challenge)
    return (
      <Shell>
        <p className="text-red-400">
          This link is missing its challenge. Re-run{" "}
          <InlineCode>npm run liveone -- auth login</InlineCode> and use the URL
          it prints.
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
    return (
      <Shell>
        <p className="text-gray-300">
          Request denied — nothing was signed in. You can close this tab.
        </p>
      </Shell>
    );

  if (state.kind === "code")
    return (
      <Shell>
        <p className="mb-3 text-gray-300">
          Paste this back into the waiting CLI:
        </p>
        <code className="block select-all break-all rounded-lg border border-gray-700 bg-gray-900 p-4 font-mono text-sm tracking-wider text-gray-100">
          {state.code}
        </code>
        <p className="mt-4 text-sm text-gray-400">
          It expires in five minutes, and is useless on its own — the CLI also
          needs the verifier it kept.
        </p>
      </Shell>
    );

  return (
    <Shell>
      <p className="mb-4 text-gray-300">
        Sign in the LiveOne CLI on{" "}
        <strong className="font-medium text-gray-100">{label}</strong>?
      </p>
      <p className="mb-6 text-sm text-gray-400">
        You are{" "}
        <strong className="font-medium text-gray-200">
          {user?.primaryEmailAddress?.emailAddress}
        </strong>
        . The CLI will act as you, and you can revoke it at any time with{" "}
        <InlineCode>auth revoke</InlineCode>.
      </p>
      {state.kind === "error" && (
        <p className="mb-4 text-sm text-red-400">{state.message}</p>
      )}
      <div className="flex gap-3">
        <Button
          onClick={approve}
          disabled={state.kind === "working"}
          className="flex-1"
        >
          {state.kind === "working" ? "Authorising…" : "Approve"}
        </Button>
        <Button
          variant="outline"
          onClick={() => setState({ kind: "denied" })}
          disabled={state.kind === "working"}
          className="flex-1"
        >
          Deny
        </Button>
      </div>
    </Shell>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-gray-900 px-1.5 py-0.5 font-mono text-[0.85em] text-gray-300">
      {children}
    </code>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-800 p-8 shadow-lg">
        <h1 className="text-2xl font-semibold text-gray-100">
          Live<span className="text-blue-500">One</span>
        </h1>
        <p className="mb-6 mt-1 text-sm text-gray-400">CLI sign-in</p>
        {children}
      </div>
    </main>
  );
}
