import type { QueryClient } from "@tanstack/react-query";
import type { AreaEditPayload } from "./types";

export const areaDetailKey = (areaId: string | null, actingAsAdmin: boolean) =>
  ["area-builder", "detail", areaId, actingAsAdmin] as const;

export async function cacheSavedAreaDetail(
  queryClient: QueryClient,
  areaId: string,
  actingAsAdmin: boolean,
  detail: AreaEditPayload,
): Promise<void> {
  const queryKey = areaDetailKey(areaId, actingAsAdmin);
  // A background GET started before PATCH may still hold the old settings. Cancel it
  // before seeding the saved response so it cannot reset the cache and editor later.
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, detail);
}
