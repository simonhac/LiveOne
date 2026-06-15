"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Copy, Check, Trash2, Link2 } from "lucide-react";
import { useModalContext } from "@/contexts/ModalContext";

/**
 * Per-dashboard Share dialog (P4). Owner-only: mint / copy / revoke read-only public links for THIS
 * dashboard. A link is the current dashboard URL plus `?access=<token>`; opening it renders the
 * dashboard read-only (no login). Talks to `POST/GET/DELETE /api/dashboard/[systemId]/share`.
 */

interface ShareTokenRow {
  token: string;
  label: string | null;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export default function DashboardShareDialog({
  isOpen,
  onClose,
  systemId,
}: {
  isOpen: boolean;
  onClose: () => void;
  systemId: string;
}) {
  const { registerModal, unregisterModal } = useModalContext();
  const [tokens, setTokens] = useState<ShareTokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [minting, setMinting] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shareUrl = (token: string) =>
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}${window.location.pathname}?access=${token}`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/${systemId}/share`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setTokens((json.tokens ?? []) as ShareTokenRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load links");
    } finally {
      setLoading(false);
    }
  }, [systemId]);

  useEffect(() => {
    if (isOpen) void refresh();
  }, [isOpen, refresh]);

  useEffect(() => {
    if (isOpen) {
      registerModal("dashboard-share-dialog");
      return () => unregisterModal("dashboard-share-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  const mint = async () => {
    setMinting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/${systemId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create link");
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (token: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/${systemId}/share`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke link");
    }
  };

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(token));
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
    } catch {
      /* clipboard unavailable — the input is selectable as a fallback */
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  const active = tokens.filter((t) => t.revokedAtMs == null);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-gray-800 shadow-xl ring-1 ring-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <Link2 className="h-5 w-5" /> Share dashboard
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-sm text-gray-400">
            Anyone with a link can view this dashboard read-only — no sign-in
            required. Revoke a link at any time.
          </p>

          <div className="flex items-end gap-3">
            <label className="text-sm text-gray-300">
              Expires
              <select
                value={expiresInDays ?? ""}
                onChange={(e) =>
                  setExpiresInDays(
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
                className="ml-2 rounded border border-gray-600 bg-gray-900 px-2 py-1 text-white"
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={o.days ?? ""}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={mint}
              disabled={minting}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {minting ? "Creating…" : "Create link"}
            </button>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="space-y-2">
            {loading && active.length === 0 ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : active.length === 0 ? (
              <p className="text-sm text-gray-500">No active links.</p>
            ) : (
              active.map((t) => (
                <div
                  key={t.token}
                  className="flex items-center gap-2 rounded border border-gray-700 bg-gray-900 px-3 py-2"
                >
                  <input
                    readOnly
                    value={shareUrl(t.token)}
                    onFocus={(e) => e.currentTarget.select()}
                    className="min-w-0 flex-1 truncate bg-transparent text-xs text-gray-300 outline-none"
                  />
                  <span className="shrink-0 text-xs text-gray-500">
                    {t.expiresAtMs
                      ? `exp ${new Date(t.expiresAtMs).toLocaleDateString()}`
                      : "no expiry"}
                  </span>
                  <button
                    onClick={() => copy(t.token)}
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-white"
                    aria-label="Copy link"
                  >
                    {copied === t.token ? (
                      <Check className="h-4 w-4 text-green-400" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    onClick={() => revoke(t.token)}
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-700 hover:text-red-400"
                    aria-label="Revoke link"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
