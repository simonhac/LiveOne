"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

/** A dashboard member as serialized by `GET /api/v4/dashboards/{id}/grants`. */
interface Member {
  clerkUserId: string;
  role: string;
  email: string | null;
  name: string | null;
  createdAtMs: number;
}

/** One entry of the `PUT` body — an existing member restated, or a new invitee to resolve. */
type MemberInput =
  | { clerkUserId: string; role: string }
  | { email: string; role: string }
  | { username: string; role: string };

/** `PUT`'s per-grantee diff (§9.2) — returned so an under- or over-applied replace is visible. */
interface GrantsChanged {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
}

/** The 422 body: `{ errors: [{ index?, code, detail? }] }`, all-or-nothing (nothing was applied). */
interface MemberError {
  index?: number;
  code?: string;
  detail?: string;
}

/** Turn one 422 entry into something a human can act on. `code` is machine vocabulary, not a message. */
function messageForError(e: MemberError): string {
  switch (e.code) {
    case "user-not-found":
      return "No user found with that email/username";
    case "owner-already-has-full-access":
      return "That person owns this dashboard already";
    case "duplicate-member":
      return "That person is already a member";
    case "malformed-clerk-user-id":
      return "That user id is malformed";
    case "unknown-role":
      return `Unknown role${e.detail ? `: ${e.detail}` : ""}`;
    default:
      return e.code ?? "Could not save members";
  }
}

/**
 * Manage who a dashboard is shared WITH (per-user grants). Distinct from the public `?access=` links
 * in ShareLinksPanel: a member signs in and reaches the dashboard read-only at `/dashboard/id/{id}`.
 * Self-contained — talks to `/api/v4/dashboards/{id}/grants` directly.
 *
 * 🛑 **The membership write is a declarative full replace (`PUT`), not the legacy add-one/remove-one
 * pair.** So "add" and "remove" are both expressed as *the whole list we want*, computed from the list
 * the panel is currently showing. Two consequences worth stating rather than rediscovering:
 *
 *  - the local `members` state is the INPUT to every write, so a stale panel would silently re-assert
 *    a stale membership. Every write reloads from the server afterwards, and a failed write reloads
 *    too — the panel never keeps optimistic state it did not have confirmed.
 *  - a member whose Clerk user was deleted comes back from the GET with `email`/`name` null and its raw
 *    `clerkUserId` intact, and is restated by `clerkUserId` here. The route accepts a raw id as-is for
 *    exactly this reason, so a GET → PUT round trip cannot quietly evict a tombstoned grantee.
 *
 * Validation is all-or-nothing and answers **422** with `{errors:[{index, code}]}` — not the legacy
 * 404/`{error:"user_not_found"}` — so one unresolvable invitee leaves the membership untouched.
 */
export default function GrantsPanel({
  dashboardId,
  enabled,
}: {
  dashboardId: string;
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
      const res = await fetch(`/api/v4/dashboards/${dashboardId}/grants`);
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

  /** The current membership, restated as PUT input (identity by `clerkUserId`, role preserved). */
  const asInput = (rows: Member[]): MemberInput[] =>
    rows.map((m) => ({ clerkUserId: m.clerkUserId, role: m.role }));

  /**
   * Declare the whole membership. Returns the server's diff on success, or null on failure (the error
   * is already surfaced). Always re-reads: the response's `members` IS the new state, so trusting it
   * costs nothing and drifting from it costs a wrong list.
   */
  const replaceMembers = async (
    next: MemberInput[],
    failureMsg: string,
  ): Promise<GrantsChanged | null> => {
    const res = await fetch(`/api/v4/dashboards/${dashboardId}/grants`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: next }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errs = (body?.errors ?? []) as MemberError[];
      setError(errs.length > 0 ? messageForError(errs[0]) : failureMsg);
      return null;
    }
    setMembers((body?.members ?? []) as Member[]);
    return (body?.changed ?? null) as GrantsChanged | null;
  };

  const add = async () => {
    const value = invitee.trim();
    if (!value) return;
    // An "@" means an email; otherwise treat it as a username. The server resolves either to a Clerk id.
    const invited: MemberInput = value.includes("@")
      ? { email: value, role: "viewer" }
      : { username: value, role: "viewer" };
    setBusy(true);
    setError(null);
    try {
      const changed = await replaceMembers(
        [...asInput(members), invited],
        "Could not add member",
      );
      if (!changed) return;
      setInvitee("");
      toast.success("Member added");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (clerkUserId: string) => {
    setBusy(true);
    setError(null);
    try {
      // Removal is stated as OMISSION from the declared list — there is no per-member DELETE.
      const changed = await replaceMembers(
        asInput(members.filter((m) => m.clerkUserId !== clerkUserId)),
        "Could not remove member",
      );
      if (!changed) return;
      toast.success("Member removed");
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
