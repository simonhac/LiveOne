import { queryOptions } from "@tanstack/react-query";
import { fetchJson } from "./fetcher";

/** The subset of user preferences the client reads (`GET /api/user/preferences`). */
export interface UserPreferencesDTO {
  clerkUserId: string;
  defaultSystemId: number | null;
  defaultDashboardId: number | null;
}

export interface UserPreferencesResponse {
  success: boolean;
  preferences: UserPreferencesDTO;
}

/** Query key for the signed-in user's preferences (invalidate after set/unset default). */
export const USER_PREFERENCES_KEY = ["user", "preferences"] as const;

/**
 * The signed-in user's preferences (`GET /api/user/preferences`) — used by the dashboard switcher to
 * star the default dashboard. Rarely changes; cache for the session and invalidate after a set/unset.
 */
export function userPreferencesQuery(enabled = true) {
  return queryOptions({
    queryKey: USER_PREFERENCES_KEY,
    queryFn: () => fetchJson<UserPreferencesResponse>("/api/user/preferences"),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
