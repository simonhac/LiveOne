"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { Button } from "@/components/ui/button";

interface TokenRow {
  token: string;
  label: string | null;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

const EXPIRY_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Never", value: null },
  { label: "1 day", value: 1 },
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

const SAMPLE_PATHS = [{ label: "Kinkora HWS lab", path: "/labs/kinkora-hws" }];

function formatRelative(ms: number | null, nowMs: number): string {
  if (ms === null) return "—";
  const diff = ms - nowMs;
  const past = diff < 0;
  const abs = Math.abs(diff);
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;
  let v: string;
  if (abs < m) v = `${Math.round(abs / 1000)}s`;
  else if (abs < h) v = `${Math.round(abs / m)}m`;
  else if (abs < d) v = `${Math.round(abs / h)}h`;
  else v = `${Math.round(abs / d)}d`;
  return past ? `${v} ago` : `in ${v}`;
}

function formatExpiry(ms: number | null, nowMs: number): string {
  if (ms === null) return "Never";
  if (ms < nowMs) return "Expired";
  return `in ${formatRelative(ms, nowMs).replace("in ", "")}`;
}

interface TokensResponse {
  tokens: TokenRow[];
}

export default function ShareTokensClient() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<number | null>(30);
  const [label, setLabel] = useState("");
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const {
    data,
    isPending,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: ["settings", "share-tokens"],
    queryFn: () => fetchJson<TokensResponse>("/api/share-tokens"),
  });

  const tokens = data?.tokens ?? [];
  const loading = isPending;
  const loadError = isError
    ? queryError instanceof Error
      ? queryError.message
      : String(queryError)
    : null;

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/share-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expiresInDays: expiry,
          label: label.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setLabel("");
      queryClient.invalidateQueries({ queryKey: ["settings", "share-tokens"] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (token: string) => {
      const res = await fetch(`/api/share-tokens/${token}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "share-tokens"] });
    },
  });

  const creating = createMutation.isPending;

  function createToken() {
    setError(null);
    createMutation.mutate(undefined, {
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }

  function revoke(token: string) {
    if (!confirm(`Revoke token ${token}?`)) return;
    setError(null);
    revokeMutation.mutate(token, {
      onError: (e) => setError(e instanceof Error ? e.message : String(e)),
    });
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
  }

  const nowMs = Date.now();
  const active = tokens.filter((t) => t.revokedAtMs === null);
  const revoked = tokens.filter((t) => t.revokedAtMs !== null);

  return (
    <div className="space-y-8">
      {(error ?? loadError) && (
        <div className="rounded border border-red-700 bg-red-950/50 px-3 py-2 text-sm text-red-300">
          {error ?? loadError}
        </div>
      )}

      <section className="bg-gray-800 rounded p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-200">Create a token</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs text-gray-400">
            Label (optional)
            <input
              type="text"
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. plumber"
              className="mt-1 rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-sm text-gray-100 w-56"
            />
          </label>
          <label className="flex flex-col text-xs text-gray-400">
            Expires
            <select
              value={expiry === null ? "null" : String(expiry)}
              onChange={(e) =>
                setExpiry(
                  e.target.value === "null" ? null : Number(e.target.value),
                )
              }
              className="mt-1 rounded bg-gray-900 border border-gray-700 px-2 py-1.5 text-sm text-gray-100"
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option
                  key={String(o.value)}
                  value={o.value === null ? "null" : String(o.value)}
                >
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={createToken} disabled={creating} variant="default">
            {creating ? "Creating…" : "Create token"}
          </Button>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-200 mb-2">
          Active tokens {active.length > 0 && `(${active.length})`}
        </h2>
        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-gray-400">No active tokens.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((t) => (
              <li
                key={t.token}
                className="bg-gray-800 rounded p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm text-orange-300">
                    {t.token}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {t.label && <span className="mr-3">{t.label}</span>}
                    <span className="mr-3">
                      created {formatRelative(t.createdAtMs, nowMs)}
                    </span>
                    <span className="mr-3">
                      expires {formatExpiry(t.expiresAtMs, nowMs)}
                    </span>
                    <span>
                      last used{" "}
                      {t.lastUsedAtMs === null
                        ? "never"
                        : formatRelative(t.lastUsedAtMs, nowMs)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copy(t.token)}
                  >
                    Copy token
                  </Button>
                  {SAMPLE_PATHS.map((p) => (
                    <Button
                      key={p.path}
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        copy(`${origin}${p.path}?access=${t.token}`)
                      }
                    >
                      Copy {p.label} URL
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => revoke(t.token)}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 mb-2">
            Revoked ({revoked.length})
          </h2>
          <ul className="space-y-1 text-xs text-gray-500">
            {revoked.map((t) => (
              <li key={t.token} className="font-mono">
                <span className="line-through">{t.token}</span>
                {" — revoked "}
                {formatRelative(t.revokedAtMs, nowMs)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
