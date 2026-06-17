"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Copy,
  Check,
  Trash2,
  Link2,
  Plus,
  Clock,
  Globe,
  AlertCircle,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { useModalContext } from "@/contexts/ModalContext";
import { formatRelativeTime, formatDate } from "@/lib/fe-date-format";

/**
 * Per-dashboard Share dialog (P4). Owner-only: mint / copy / rename / revoke read-only public links
 * for THIS dashboard. A link is the current dashboard URL plus `?access=<token>`; opening it renders
 * the dashboard read-only (no login). Talks to `POST/GET/PATCH/DELETE /api/dashboard/[systemId]/share`.
 *
 * Every link requires a free-text name (sent as `label`, capped at 80 chars to match the legacy
 * share-tokens convention). Links are shown in a compact table; the name is the primary column, with
 * the URL reachable via the Copy action. Pre-existing tokens without a label render as "Untitled
 * link". Names are editable inline (PATCH). Creating a link auto-copies it and confirms with a toast,
 * and the Create button stays disabled until a real name is entered.
 *
 * NOTE: the server (POST/PATCH) independently rejects empty labels, so non-UI callers can't create
 * unnamed tokens.
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

// Match the legacy share-tokens convention (`label.slice(0, 80)`).
const MAX_LABEL_LEN = 80;

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
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const trimmedName = name.trim();
  const canCreate = trimmedName.length > 0 && !minting;
  const trimmedEdit = editValue.trim();
  const canSaveEdit = trimmedEdit.length > 0 && !savingEdit;

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

  // Reset the composer each time the dialog opens, and focus the name field.
  useEffect(() => {
    if (!isOpen) return;
    setName("");
    setExpiresInDays(null);
    setNameError(null);
    setError(null);
    setEditingToken(null);
    const id = window.setTimeout(() => nameInputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      registerModal("dashboard-share-dialog");
      return () => unregisterModal("dashboard-share-dialog");
    }
  }, [isOpen, registerModal, unregisterModal]);

  // Escape cancels an in-progress rename first, otherwise closes the dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editingToken) {
        setEditingToken(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, editingToken]);

  const copyToken = useCallback(async (token: string) => {
    try {
      await navigator.clipboard.writeText(
        typeof window === "undefined"
          ? ""
          : `${window.location.origin}${window.location.pathname}?access=${token}`,
      );
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
    } catch {
      // Clipboard unavailable — fail quietly; the link still exists in the table.
    }
  }, []);

  const mint = async () => {
    const label = trimmedName.slice(0, MAX_LABEL_LEN);
    if (!label) {
      setNameError("Give this link a name so you can recognise it later.");
      nameInputRef.current?.focus();
      return;
    }
    setNameError(null);
    setMinting(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/${systemId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays, label }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      await refresh();

      // Reward the primary task: clear the form, auto-copy the new link, confirm via toast.
      setName("");
      setExpiresInDays(null);
      if (typeof json?.token === "string") {
        void copyToken(json.token);
      }
      toast.success(`Created “${label}”`, {
        description:
          "Link copied to your clipboard. Paste it anywhere to share.",
      });
      nameInputRef.current?.focus();
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

  const startEdit = (t: ShareTokenRow) => {
    setEditingToken(t.token);
    setEditValue(t.label ?? "");
    setError(null);
    window.setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const editName = async (token: string) => {
    const label = trimmedEdit.slice(0, MAX_LABEL_LEN);
    if (!label) {
      editInputRef.current?.focus();
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/${systemId}/share`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, label }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingToken(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename link");
    } finally {
      setSavingEdit(false);
    }
  };

  const onNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (canCreate) void mint();
      else setNameError("Give this link a name so you can recognise it later.");
    }
  };

  const onEditKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    token: string,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (canSaveEdit) void editName(token);
    }
    // Escape is handled by the dialog-level listener (cancels the edit).
  };

  if (!isOpen || typeof document === "undefined") return null;

  const active = tokens.filter((t) => t.revokedAtMs == null);

  return createPortal(
    // Anchor near the top so the panel grows downward as links are added — it never
    // recenters/jumps. The overlay itself scrolls if the panel is taller than the viewport.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:py-[8vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[612px] overflow-hidden rounded-lg bg-gray-800 shadow-xl ring-1 ring-gray-700"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Share dashboard"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-3.5">
          <h2 className="flex items-center gap-2.5 text-lg font-semibold text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600/15 text-blue-400 ring-1 ring-inset ring-blue-500/20">
              <Link2 className="h-4 w-4" />
            </span>
            Share dashboard
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <p className="text-sm leading-relaxed text-gray-400">
            Anyone with a link can view this dashboard read-only — no sign-in
            required. Give each link a name so you can tell them apart, and
            revoke any of them at any time.
          </p>

          {/* Create composer — subtly elevated panel */}
          <div className="rounded-lg bg-gray-900/70 p-4 ring-1 ring-gray-700/80">
            <label
              htmlFor="share-link-name"
              className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-400"
            >
              Link name <span className="text-red-400">*</span>
            </label>
            <input
              id="share-link-name"
              ref={nameInputRef}
              type="text"
              value={name}
              maxLength={MAX_LABEL_LEN}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              onKeyDown={onNameKeyDown}
              placeholder="e.g. Investor demo, Mum's iPad"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "share-link-name-error" : undefined}
              className={`w-full rounded-md border bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500 ${
                nameError ? "border-red-500/70" : "border-gray-600"
              }`}
            />

            <div className="mt-2 flex items-center justify-between gap-2">
              {nameError ? (
                <p
                  id="share-link-name-error"
                  className="flex items-center gap-1.5 text-xs text-red-400"
                >
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {nameError}
                </p>
              ) : (
                <span aria-hidden className="select-none text-xs text-gray-600">
                  &nbsp;
                </span>
              )}
              <span className="shrink-0 text-xs tabular-nums text-gray-500">
                {trimmedName.length}/{MAX_LABEL_LEN}
              </span>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <Clock className="h-4 w-4 text-gray-500" />
                <span className="text-gray-400">Expires</span>
                <select
                  value={expiresInDays ?? ""}
                  onChange={(e) =>
                    setExpiresInDays(
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                  className="rounded-md border border-gray-600 bg-gray-800 px-2 py-1 text-sm text-white outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
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
                disabled={!canCreate}
                title={
                  trimmedName.length === 0
                    ? "Enter a name first"
                    : "Create link"
                }
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {minting ? (
                  "Creating…"
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Create link
                  </>
                )}
              </button>
            </div>
          </div>

          {error && (
            <p className="flex items-center gap-1.5 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </p>
          )}

          {/* Active links */}
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              Active links
              {active.length > 0 && (
                <span className="rounded-full bg-gray-700 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-gray-300">
                  {active.length}
                </span>
              )}
            </h3>

            {loading && active.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">Loading…</p>
            ) : active.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-700 bg-gray-900/40 px-4 py-8 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-800 text-gray-500 ring-1 ring-gray-700">
                  <Globe className="h-5 w-5" />
                </span>
                <p className="text-sm font-medium text-gray-300">
                  No active links yet
                </p>
                <p className="max-w-xs text-xs leading-relaxed text-gray-500">
                  Name a link above and create it to share a read-only view of
                  this dashboard.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-gray-700">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700 bg-gray-900/60 text-left text-[11px] uppercase tracking-wide text-gray-500">
                      <th className="w-full py-2 pl-3 pr-2 font-medium">
                        Name
                      </th>
                      <th className="hidden px-2 py-2 font-medium sm:table-cell">
                        Expires
                      </th>
                      <th className="hidden px-2 py-2 font-medium sm:table-cell">
                        Last used
                      </th>
                      <th className="py-2 pl-2 pr-3 text-right font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {active.map((t) => {
                      const isCopied = copied === t.token;
                      const isEditing = editingToken === t.token;
                      const hasName = !!t.label && t.label.trim().length > 0;
                      const displayName = hasName
                        ? (t.label as string)
                        : "Untitled link";
                      const expired =
                        t.expiresAtMs != null && t.expiresAtMs <= Date.now();
                      return (
                        <tr key={t.token} className="bg-gray-900/30">
                          {isEditing ? (
                            <td colSpan={4} className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <input
                                  ref={editInputRef}
                                  type="text"
                                  value={editValue}
                                  maxLength={MAX_LABEL_LEN}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onKeyDown={(e) => onEditKeyDown(e, t.token)}
                                  placeholder="Link name"
                                  aria-label="Rename link"
                                  className="min-w-0 flex-1 rounded-md border border-gray-600 bg-gray-800 px-2.5 py-1.5 text-sm text-white placeholder-gray-500 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                                />
                                <button
                                  onClick={() => editName(t.token)}
                                  disabled={!canSaveEdit}
                                  className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {savingEdit ? "Saving…" : "Save"}
                                </button>
                                <button
                                  onClick={() => setEditingToken(null)}
                                  className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
                                >
                                  Cancel
                                </button>
                              </div>
                            </td>
                          ) : (
                            <>
                              <td className="w-full max-w-0 py-2 pl-3 pr-2">
                                <span
                                  className={`block truncate font-medium ${
                                    hasName
                                      ? "text-white"
                                      : "italic text-gray-500"
                                  }`}
                                  title={`${displayName} — ${shareUrl(t.token)}`}
                                >
                                  {displayName}
                                </span>
                              </td>
                              <td
                                className={`hidden whitespace-nowrap px-2 py-2 text-xs sm:table-cell ${
                                  expired ? "text-red-400" : "text-gray-400"
                                }`}
                              >
                                {t.expiresAtMs == null
                                  ? "Never"
                                  : expired
                                    ? "Expired"
                                    : formatDate(new Date(t.expiresAtMs))}
                              </td>
                              <td className="hidden whitespace-nowrap px-2 py-2 text-xs text-gray-500 sm:table-cell">
                                {t.lastUsedAtMs
                                  ? formatRelativeTime(new Date(t.lastUsedAtMs))
                                  : "Never"}
                              </td>
                              <td className="py-2 pl-2 pr-3">
                                <div className="flex items-center justify-end gap-0.5">
                                  <button
                                    onClick={() => copyToken(t.token)}
                                    className={`rounded-md p-1.5 transition-colors ${
                                      isCopied
                                        ? "text-green-400"
                                        : "text-gray-400 hover:bg-gray-700 hover:text-white"
                                    }`}
                                    aria-label={`Copy link for ${displayName}`}
                                    title="Copy link"
                                  >
                                    {isCopied ? (
                                      <Check className="h-4 w-4" />
                                    ) : (
                                      <Copy className="h-4 w-4" />
                                    )}
                                  </button>
                                  <button
                                    onClick={() => startEdit(t)}
                                    className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-700 hover:text-white"
                                    aria-label={`Rename ${displayName}`}
                                    title="Rename link"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </button>
                                  <button
                                    onClick={() => revoke(t.token)}
                                    className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                                    aria-label={`Revoke ${displayName}`}
                                    title="Revoke link"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
