import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { Crown } from "lucide-react";

/**
 * Per-device admin settings: ownership.
 *
 * This tab used to have a second "Viewers" section — an add/remove list of per-device read-only
 * grantees, persisted to `user_systems`. That table was dropped in migration 0045 (config-v4 Phase 12
 * slice F): it held zero rows on prod and the clean-sheet retires it with no replacement. Per-person
 * sharing is `dashboard_grants` (invite) + `share_tokens` (public link), both managed per-DASHBOARD,
 * not per-device — so do not resurrect this section; the equivalent UI belongs on a dashboard.
 */

interface User {
  clerkUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

interface AdminData {
  ownerClerkUserId: string | null;
}

interface UsersResponse {
  success: boolean;
  users: Array<{
    clerkUserId: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    username?: string;
  }>;
}

interface AdminSettingsResponse {
  success: boolean;
  ownerClerkUserId: string | null;
}

interface AdminTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<AdminData>) => void;
}

export default function AdminTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
}: AdminTabProps) {
  const [ownerClerkUserId, setOwnerClerkUserId] = useState<string | null>(null);
  const [initialOwner, setInitialOwner] = useState<string | null>(null);

  // Fetch all users
  const usersQuery = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => fetchJson<UsersResponse>("/api/admin/users"),
    enabled: shouldLoad,
  });

  // Fetch current admin settings for this device
  const settingsQuery = useQuery({
    queryKey: ["system", systemId, "admin-config"],
    queryFn: () =>
      fetchJson<AdminSettingsResponse>(
        `/api/admin/devices/${systemId}/admin-settings`,
      ),
    enabled: shouldLoad,
  });

  const allUsers = useMemo<User[]>(() => {
    if (!usersQuery.data?.success) return [];
    return usersQuery.data.users.map((u) => ({
      clerkUserId: u.clerkUserId,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      username: u.username,
    }));
  }, [usersQuery.data]);

  const loading = usersQuery.isPending || settingsQuery.isPending;

  // Seed editable form state from the fetched admin settings (replaces the
  // in-fetch seeding); re-seeds whenever fresh server data arrives.
  const settingsData = settingsQuery.data;
  useEffect(() => {
    if (settingsData?.success) {
      setOwnerClerkUserId(settingsData.ownerClerkUserId);
      setInitialOwner(settingsData.ownerClerkUserId);
    }
  }, [settingsData]);

  // Check if data is dirty
  const isDirty = useMemo(
    () => ownerClerkUserId !== initialOwner,
    [ownerClerkUserId, initialOwner],
  );

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Provide save function to parent
  const getAdminData = useCallback(async (): Promise<AdminData> => {
    return { ownerClerkUserId };
  }, [ownerClerkUserId]);

  useEffect(() => {
    onSaveFunctionReady?.(getAdminData);
  }, [onSaveFunctionReady, getAdminData]);

  // Get display name for a user
  const getDisplayName = (user: User): string => {
    if (user.firstName || user.lastName) {
      return [user.firstName, user.lastName].filter(Boolean).join(" ");
    }
    if (user.username) {
      return user.username;
    }
    return user.email || user.clerkUserId;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading admin settings...</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-400">Manage device ownership.</p>

      {/* Owner Section */}
      <div className="border border-gray-700 rounded-lg p-4 bg-blue-500/5">
        <div className="flex items-center gap-2 mb-3">
          <Crown className="w-5 h-5 text-yellow-400" />
          <h3 className="text-sm font-semibold text-gray-200">Owner</h3>
          <span className="text-xs text-gray-500">(full control)</span>
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-gray-400">
            Select device owner
          </label>
          <select
            value={ownerClerkUserId || ""}
            onChange={(e) => setOwnerClerkUserId(e.target.value || null)}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">No owner</option>
            {allUsers.map((user) => (
              <option key={user.clerkUserId} value={user.clerkUserId}>
                {getDisplayName(user)}
                {user.email && ` (${user.email})`}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
