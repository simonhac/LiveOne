import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Plus, X, Eye, Crown } from "lucide-react";
import { createPortal } from "react-dom";

interface User {
  clerkUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

interface Viewer {
  clerkUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

interface AdminData {
  ownerClerkUserId: string | null;
  viewers: Viewer[];
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
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [initialOwner, setInitialOwner] = useState<string | null>(null);
  const [initialViewers, setInitialViewers] = useState<Viewer[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [menuButtonRef, setMenuButtonRef] = useState<HTMLButtonElement | null>(
    null,
  );
  const fetchingRef = useRef(false);

  // Reset hasLoaded when modal closes
  useEffect(() => {
    if (!shouldLoad && hasLoaded) {
      setHasLoaded(false);
      setLoading(true);
      fetchingRef.current = false;
    }
  }, [shouldLoad, hasLoaded]);

  const fetchAdminData = useCallback(async () => {
    fetchingRef.current = true;
    try {
      // Fetch all users
      const usersResponse = await fetch("/api/admin/users");
      const usersData = await usersResponse.json();

      if (usersData.success) {
        setAllUsers(
          usersData.users.map((u: any) => ({
            clerkUserId: u.clerkUserId,
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            username: u.username,
          })),
        );
      }

      // Fetch current admin settings for this system
      const systemResponse = await fetch(
        `/api/admin/systems/${systemId}/admin-settings`,
      );
      const systemData = await systemResponse.json();

      if (systemData.success) {
        setOwnerClerkUserId(systemData.ownerClerkUserId);
        setInitialOwner(systemData.ownerClerkUserId);
        setViewers(systemData.viewers || []);
        setInitialViewers(JSON.parse(JSON.stringify(systemData.viewers || [])));
        setHasLoaded(true);
      }
    } catch (error) {
      console.error("Failed to fetch admin data:", error);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [systemId]);

  useEffect(() => {
    if (shouldLoad && !hasLoaded && !fetchingRef.current) {
      fetchAdminData();
    }
  }, [systemId, shouldLoad, hasLoaded, fetchAdminData]);

  // Check if data is dirty
  const isDirty = useMemo(() => {
    const ownerChanged = ownerClerkUserId !== initialOwner;
    const viewersChanged =
      JSON.stringify(viewers.map((v) => v.clerkUserId).sort()) !==
      JSON.stringify(initialViewers.map((v) => v.clerkUserId).sort());
    return ownerChanged || viewersChanged;
  }, [ownerClerkUserId, viewers, initialOwner, initialViewers]);

  // Notify parent when dirty state changes
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Provide save function to parent
  const getAdminData = useCallback(async (): Promise<AdminData> => {
    return {
      ownerClerkUserId,
      viewers: viewers.map((v) => ({
        clerkUserId: v.clerkUserId,
        email: v.email,
        firstName: v.firstName,
        lastName: v.lastName,
        username: v.username,
      })),
    };
  }, [ownerClerkUserId, viewers]);

  useEffect(() => {
    onSaveFunctionReady?.(getAdminData);
  }, [onSaveFunctionReady, getAdminData]);

  // Get display name for a user
  const getDisplayName = (user: User | Viewer): string => {
    if (user.firstName || user.lastName) {
      return [user.firstName, user.lastName].filter(Boolean).join(" ");
    }
    if (user.username) {
      return user.username;
    }
    return user.email || user.clerkUserId;
  };

  const handleAddViewer = (buttonElement: HTMLButtonElement) => {
    setShowUserMenu(true);
    setMenuButtonRef(buttonElement);
  };

  const handleCloseMenu = () => {
    setShowUserMenu(false);
    setMenuButtonRef(null);
  };

  const handleSelectUser = (user: User) => {
    // Don't add if already a viewer
    if (viewers.some((v) => v.clerkUserId === user.clerkUserId)) {
      handleCloseMenu();
      return;
    }

    setViewers((prev) => [...prev, user]);
    handleCloseMenu();
  };

  const handleRemoveViewer = (index: number) => {
    setViewers((prev) => prev.filter((_, i) => i !== index));
  };

  // Filter available users for viewer selection (exclude owner and existing viewers)
  const getAvailableUsers = (): User[] => {
    const viewerIds = new Set(viewers.map((v) => v.clerkUserId));
    return allUsers.filter(
      (u) =>
        u.clerkUserId !== ownerClerkUserId && !viewerIds.has(u.clerkUserId),
    );
  };

  // Render popup menu for adding viewers
  const renderUserMenu = () => {
    if (!showUserMenu || !menuButtonRef || typeof document === "undefined") {
      return null;
    }

    const availableUsers = getAvailableUsers();

    // Calculate position
    const rect = menuButtonRef.getBoundingClientRect();
    const menuWidth = 320;
    const menuMaxHeight = 300;

    // Position below the button, aligned to the right
    let left = rect.right - menuWidth;
    let top = rect.bottom + 4;

    // Ensure menu doesn't go off left edge
    if (left < 8) {
      left = 8;
    }

    // Ensure menu doesn't go off right edge
    if (left + menuWidth > window.innerWidth - 8) {
      left = window.innerWidth - menuWidth - 8;
    }

    // Ensure menu doesn't go off bottom edge
    if (top + menuMaxHeight > window.innerHeight - 8) {
      // Position above the button instead
      top = rect.top - menuMaxHeight - 4;
      // If still off screen, position at top of viewport
      if (top < 8) {
        top = 8;
      }
    }

    return createPortal(
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 z-[10002]" onClick={handleCloseMenu} />

        {/* Menu */}
        <div
          className="fixed z-[10003] bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden"
          style={{
            left: `${left}px`,
            top: `${top}px`,
            width: `${menuWidth}px`,
            maxHeight: `${menuMaxHeight}px`,
          }}
        >
          <div className="overflow-y-auto max-h-full">
            {availableUsers.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">
                No available users to add
              </div>
            ) : (
              availableUsers.map((user) => (
                <button
                  key={user.clerkUserId}
                  onClick={() => handleSelectUser(user)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors border-b border-gray-800 last:border-b-0"
                >
                  <div className="font-medium">{getDisplayName(user)}</div>
                  {user.email && (
                    <div className="text-xs text-gray-500">{user.email}</div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </>,
      document.body,
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading admin settings...</div>
      </div>
    );
  }

  const currentOwner = allUsers.find((u) => u.clerkUserId === ownerClerkUserId);

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-400">
        Manage system ownership and user access permissions.
      </p>

      {renderUserMenu()}

      {/* Owner Section */}
      <div className="border border-gray-700 rounded-lg p-4 bg-blue-500/5">
        <div className="flex items-center gap-2 mb-3">
          <Crown className="w-5 h-5 text-yellow-400" />
          <h3 className="text-sm font-semibold text-gray-200">Owner</h3>
          <span className="text-xs text-gray-500">(full control)</span>
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-gray-400">
            Select system owner
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

      {/* Viewers Section */}
      <div className="border border-gray-700 rounded-lg p-4 bg-green-500/5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-200">Viewers</h3>
            <span className="text-xs text-gray-500">(read-only access)</span>
          </div>
          <button
            onClick={(e) => handleAddViewer(e.currentTarget)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-400/10 rounded transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>

        {viewers.length > 0 ? (
          <div className="space-y-1">
            {viewers.map((viewer, index) => (
              <div
                key={viewer.clerkUserId}
                className="flex items-center justify-between bg-gray-900/50 px-3 py-2 rounded-md"
              >
                <div>
                  <div className="text-sm font-medium text-gray-300">
                    {getDisplayName(viewer)}
                  </div>
                  {viewer.email && (
                    <div className="text-xs text-gray-500">{viewer.email}</div>
                  )}
                </div>
                <button
                  onClick={() => handleRemoveViewer(index)}
                  className="text-gray-500 hover:text-red-400 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-500 italic">
            No viewers configured
          </div>
        )}
      </div>
    </div>
  );
}
