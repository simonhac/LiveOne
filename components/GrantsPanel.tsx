"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

/** A dashboard member as serialized by `GET /api/dashboards/[id]/grants`. */
interface Member {
  clerkUserId: string;
  role: string;
  email: string | null;
  name: string | null;
  createdAtMs: number;
}

/**
 * Manage who a dashboard is shared WITH (per-user grants). Distinct from the public `?access=` links
 * in ShareLinksPanel: a member signs in and reaches the dashboard read-only at `/dashboard/id/{id}`.
 * Self-contained — talks to `/api/dashboards/{id}/grants` directly.
 */
export default function GrantsPanel({
  dashboardId,
  enabled,
}: {
  dashboardId: number;
  enabled: boolean;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [invitee, setInvitee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/grants`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMembers(((await res.json()).members ?? []) as Member[]);
    } catch {
      setError("Could not load members");
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const add = async () => {
    const value = invitee.trim();
    if (!value) return;
    // An "@" means an email; otherwise treat it as a username.
    const payload = value.includes("@")
      ? { email: value }
      : { username: value };
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, role: "viewer" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          body?.error === "user_not_found"
            ? "No user found with that email/username"
            : (body?.error ?? "Could not add member"),
        );
        return;
      }
      setInvitee("");
      toast.success("Member added");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (clerkUserId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboards/${dashboardId}/grants?clerkUserId=${encodeURIComponent(clerkUserId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Member removed");
      await refresh();
    } catch {
      setError("Could not remove member");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Invite people to view this dashboard. They sign in and see it read-only,
        scoped to exactly what it shows.
      </p>
      <div className="flex gap-2">
        <input
          value={invitee}
          onChange={(e) => setInvitee(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="email or username"
          className="w-full rounded-md border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-600"
        />
        <button
          onClick={add}
          disabled={busy || !invitee.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <UserPlus className="h-4 w-4" />
          Add
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-gray-500">No members yet.</p>
      ) : (
        <ul className="divide-y divide-gray-700/60 rounded-md border border-gray-700/60">
          {members.map((m) => (
            <li
              key={m.clerkUserId}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-gray-100">
                  {m.email ?? m.name ?? m.clerkUserId}
                </div>
                <div className="text-xs text-gray-500">{m.role}</div>
              </div>
              <button
                onClick={() => remove(m.clerkUserId)}
                disabled={busy}
                title="Remove member"
                className="rounded p-1.5 text-gray-400 transition-colors hover:bg-red-950/40 hover:text-red-400 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
