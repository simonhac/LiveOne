"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Copy, Trash2, Plus, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";

interface ShareToken {
  token: string;
  label: string | null;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
  createdAtMs: number;
}

/**
 * Read-only share links for a composition dashboard. Lists / mints / revokes `dashboard_share_tokens`
 * via /api/dashboards/[id]/share; a holder opens `/dashboard/id/{id}?access=<token>` with no sign-in,
 * scoped to exactly what the dashboard shows.
 */
export default function CompositionShareDialog({
  isOpen,
  onClose,
  dashboardId,
}: {
  isOpen: boolean;
  onClose: () => void;
  dashboardId: number;
}) {
  const [tokens, setTokens] = useState<ShareToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/share`);
      if (res.ok) setTokens((await res.json()).tokens ?? []);
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const create = async () => {
    setCreating(true);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      if (res.ok) {
        setLabel("");
        await load();
        toast.success("Share link created");
      } else {
        toast.error("Could not create the link");
      }
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: string) => {
    const res = await fetch(
      `/api/dashboards/${dashboardId}/share?token=${encodeURIComponent(token)}`,
      { method: "DELETE" },
    );
    if (res.ok) {
      await load();
      toast.success("Link revoked");
    } else {
      toast.error("Could not revoke the link");
    }
  };

  const shareUrl = (token: string) =>
    `${window.location.origin}/dashboard/id/${dashboardId}?access=${token}`;

  const copy = (token: string) => {
    void navigator.clipboard.writeText(shareUrl(token));
    toast.success("Link copied");
  };

  if (!isOpen) return null;
  const active = tokens.filter((t) => !t.revokedAtMs);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-gray-700 bg-gray-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <LinkIcon className="h-4 w-4 text-gray-400" />
            Share dashboard
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-gray-400">
          Anyone with a link can view this dashboard read-only — no sign-in.
          Each link is scoped to exactly what this dashboard shows; revoke any
          time.
        </p>

        <div className="mb-4 flex gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !creating && create()}
            placeholder="Label (optional)"
            className="flex-1 rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500"
          />
          <button
            onClick={create}
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            New link
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-gray-500">No active links yet.</p>
        ) : (
          <ul className="space-y-2">
            {active.map((t) => (
              <li
                key={t.token}
                className="flex items-center gap-2 rounded-md border border-gray-700 bg-gray-800/50 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white">
                    {t.label || t.token}
                  </div>
                  <div className="truncate text-xs text-gray-500">
                    {t.token}
                    {t.expiresAtMs
                      ? ` · expires ${new Date(t.expiresAtMs).toLocaleDateString()}`
                      : ""}
                  </div>
                </div>
                <button
                  onClick={() => copy(t.token)}
                  title="Copy link"
                  className="flex-shrink-0 text-gray-400 hover:text-white"
                >
                  <Copy className="h-4 w-4" />
                </button>
                <button
                  onClick={() => revoke(t.token)}
                  title="Revoke link"
                  className="flex-shrink-0 text-gray-400 hover:text-red-400"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
