import { describe, expect, it } from "@jest/globals";
import { QueryClient } from "@tanstack/react-query";
import {
  areaDetailKey,
  cacheSavedAreaDetail,
} from "@/components/area-builder/cache";
import type { AreaEditPayload } from "@/components/area-builder/types";

function detail(displayTimezone: string, state: string): AreaEditPayload {
  return {
    area: {
      id: "ar_test",
      name: "Home",
      slug: "home",
      displayTimezone,
      dayOffsetMin: 600,
      location: { country: "AU", state },
      status: "active",
      capabilities: [],
      legacySystemId: 42,
    },
    members: [],
    bindings: [],
  };
}

describe("saving area editor detail", () => {
  it.each([false, true])(
    "keeps the saved settings when an older GET finishes (admin=%s)",
    async (admin) => {
      const client = new QueryClient();
      try {
        const key = areaDetailKey("ar_test", admin);
        const oldDetail = detail("Australia/Melbourne", "VIC");
        const savedDetail = detail("Australia/Adelaide", "SA");
        client.setQueryData(key, oldDetail);

        let finishRead!: (value: AreaEditPayload) => void;
        const delayedResponse = new Promise<AreaEditPayload>((resolve) => {
          finishRead = resolve;
        });
        // Mirrors reopening stale cached detail: the old values remain usable while
        // GET runs. Deliberately ignore AbortSignal, as the current fetcher does.
        const pendingRead = client
          .fetchQuery({
            queryKey: key,
            queryFn: () => delayedResponse,
            staleTime: 0,
          })
          .catch((error: unknown) => error);
        expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");

        await cacheSavedAreaDetail(client, "ar_test", admin, savedDetail);
        finishRead(oldDetail);
        await pendingRead;
        // Flush the original transport promise too: its late completion must be ignored.
        await delayedResponse;
        expect(client.getQueryData(key)).toEqual(savedDetail);
        expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
      } finally {
        client.clear();
      }
    },
  );

  it("does not cancel detail reads for another area or admin scope", async () => {
    const client = new QueryClient();
    try {
      const otherKeys = [
        areaDetailKey("ar_other", false),
        areaDetailKey("ar_test", true),
      ];
      let finishRead!: (value: AreaEditPayload) => void;
      const delayedResponse = new Promise<AreaEditPayload>((resolve) => {
        finishRead = resolve;
      });
      const pendingReads = otherKeys.map((queryKey) =>
        client.fetchQuery({
          queryKey,
          queryFn: () => delayedResponse,
        }),
      );
      const savedDetail = detail("Australia/Adelaide", "SA");
      await cacheSavedAreaDetail(client, "ar_test", false, savedDetail);
      for (const key of otherKeys)
        expect(client.getQueryState(key)?.fetchStatus).toBe("fetching");
      finishRead(detail("Australia/Melbourne", "VIC"));
      await Promise.all(pendingReads);
      expect(client.getQueryData(areaDetailKey("ar_test", false))).toEqual(
        savedDetail,
      );
    } finally {
      client.clear();
    }
  });
});
