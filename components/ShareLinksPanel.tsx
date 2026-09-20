"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Check,
  Trash2,
  Plus,
  Clock,
  Globe,
  AlertCircle,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { formatRelativeTime, formatDate } from "@/lib/fe-date-format";

/**
 * Reusable read-only share-link manager (the rich table + composer formerly inside
 * DashboardShareDialog). Renders inline — no modal chrome — so it can live as a tab/section inside a
 * settings dialog. Every link requires a free-text name (capped at 80 chars to match the legacy
 * share-tokens convention); links carry an optional expiry, last-used time, inline rename and revoke.
 *
 * The two address-space differences between share surfaces are injected: `shareUrl(token)` builds the
 * public link, and `api` performs list/create/revoke/rename against the right endpoint.
 */

export interface ShareTokenRow {
  token: string;
  label: string | null;
  createdAtMs: number | null;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  lastUsedAtMs: number | null;
}

export interface ShareApi {
  list: () => Promise<ShareTokenRow[]>;
  create: (
    label: string,
    expiresInDays: number | null,
  ) => Promise<{ token: string } | null>;
  revoke: (token: string) => Promise<void>;
  rename: (token: string, label: string) => Promise<void>;
}

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

// Match the legacy share-tokens convention (`label.slice(0, 80)`).
const MAX_LABEL_LEN = 80;

export default function ShareLinksPanel({
  api,
  shareUrl,
  enabled = true,
}: {
  api: ShareApi;
  shareUrl: (token: string) => string;
  /** Fetch links when true (e.g. when the containing tab/dialog is open). */
  enabled?: boolean;
}) {
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTokens(await api.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load links");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (enabled) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const copyToken = useCallback(
    async (token: string) => {
      try {
        await navigator.clipboard.writeText(shareUrl(token));
        setCopied(token);
        setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
      } catch {
        // Clipboard unavailable — fail quietly; the link still exists in the table.
      }
    },
    [shareUrl],
  );

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
      const created = await api.create(label, expiresInDays);
      await refresh();

      // Reward the primary task: clear the form, auto-copy the new link, confirm via toast.
      setName("");
      setExpiresInDays(null);
      if (created?.token) {
        void copyToken(created.token);
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
      await api.revoke(token);
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
      await api.rename(token, label);
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
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingToken(null);
    }
  };

  const active = tokens.filter((t) => t.revokedAtMs == null);

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-ink-muted">
        Anyone with a link can view this dashboard read-only — no sign-in
        required. Give each link a name so you can tell them apart, and revoke
        any of them at any time.
      </p>

      {/* Create composer — subtly elevated panel */}
      <div className="rounded-lg bg-surface-panel-strong p-4 ring-1 ring-line">
        <label
          htmlFor="share-link-name"
          className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-ink-muted"
        >
          Link name <span className="text-danger">*</span>
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
          className={`w-full rounded-md border bg-surface-overlay px-3 py-2 text-sm text-ink placeholder-ink-faint outline-none transition-colors focus:border-focus focus:ring-1 focus:ring-focus ${
            nameError ? "border-danger-line" : "border-line-strong"
          }`}
        />

        <div className="mt-2 flex items-center justify-between gap-2">
          {nameError ? (
            <p
              id="share-link-name-error"
              className="flex items-center gap-1.5 text-xs text-danger"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {nameError}
            </p>
          ) : (
            <span aria-hidden className="select-none text-xs text-ink-disabled">
              &nbsp;
            </span>
          )}
          <span className="shrink-0 text-xs tabular-nums text-ink-faint">
            {trimmedName.length}/{MAX_LABEL_LEN}
          </span>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-ink-secondary">
            <Clock className="h-4 w-4 text-ink-faint" />
            <span className="text-ink-muted">Expires</span>
            <select
              value={expiresInDays ?? ""}
              onChange={(e) =>
                setExpiresInDays(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              className="rounded-md border border-line-strong bg-surface-overlay px-2 py-1 text-sm text-ink outline-none transition-colors focus:border-focus focus:ring-1 focus:ring-focus"
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
              trimmedName.length === 0 ? "Enter a name first" : "Create link"
            }
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-ink shadow-sm transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
        <p className="flex items-center gap-1.5 text-sm text-danger">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      {/* Active links */}
      <div>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
          Active links
          {active.length > 0 && (
            <span className="rounded-full bg-surface-control px-1.5 py-0.5 text-[11px] font-semibold leading-none text-ink-secondary">
              {active.length}
            </span>
          )}
        </h3>

        {loading && active.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">Loading…</p>
        ) : active.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-surface-panel px-4 py-8 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-overlay text-ink-faint ring-1 ring-line">
              <Globe className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-ink-secondary">
              No active links yet
            </p>
            <p className="max-w-xs text-xs leading-relaxed text-ink-faint">
              Name a link above and create it to share a read-only view of this
              dashboard.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-panel-strong text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pl-3 pr-2 font-medium">Name</th>
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
              <tbody className="divide-y divide-line">
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
                    <tr key={t.token} className="bg-surface-panel">
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
                              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface-overlay px-2.5 py-1.5 text-sm text-ink placeholder-ink-faint outline-none transition-colors focus:border-focus focus:ring-1 focus:ring-focus"
                            />
                            <button
                              onClick={() => editName(t.token)}
                              disabled={!canSaveEdit}
                              className="shrink-0 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {savingEdit ? "Saving…" : "Save"}
                            </button>
                            <button
                              onClick={() => setEditingToken(null)}
                              className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-control hover:text-ink"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      ) : (
                        <>
                          <td className="max-w-0 py-2 pl-3 pr-2">
                            <span
                              className={`block truncate font-medium ${
                                hasName ? "text-ink" : "italic text-ink-faint"
                              }`}
                              title={`${displayName} — ${shareUrl(t.token)}`}
                            >
                              {displayName}
                            </span>
                          </td>
                          <td
                            className={`hidden whitespace-nowrap px-2 py-2 text-xs sm:table-cell ${
                              expired ? "text-danger" : "text-ink-muted"
                            }`}
                          >
                            {t.expiresAtMs == null
                              ? "Never"
                              : expired
                                ? "Expired"
                                : formatDate(new Date(t.expiresAtMs))}
                          </td>
                          <td className="hidden whitespace-nowrap px-2 py-2 text-xs text-ink-faint sm:table-cell">
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
                                    ? "text-ok"
                                    : "text-ink-muted hover:bg-surface-control hover:text-ink"
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
                                className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-control hover:text-ink"
                                aria-label={`Rename ${displayName}`}
                                title="Rename link"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => revoke(t.token)}
                                className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-danger-wash hover:text-danger"
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
  );
}
