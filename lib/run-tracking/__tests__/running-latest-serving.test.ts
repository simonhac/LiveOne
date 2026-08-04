/**
 * Derived points mint outside the ingest path, and they hit the same trap: a fresh
 * `<role stem>/running` point is absent from the KV serving registry, so its value reaches the
 * device's latest hash and no area's. That is not hypothetical — `ev/running` (Kinkora Mondo) was
 * minted after the Kinkora Unified bindings were authored and its live value has never appeared in
 * that area's map.
 *
 * So: rebuild on a fresh mint, before the first value is published; do nothing on the (overwhelmingly
 * common) already-exists path, which runs every minute per detector.
 */
import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.mock("@/lib/point/mint-point", () => ({
  mintPoint: jest.fn(),
  findPointByStemMetric: jest.fn(),
}));
jest.mock("@/lib/kv-cache-manager", () => ({
  updateLatestPointValue: jest.fn(async () => {}),
  refreshServingForMintedPoints: jest.fn(async () => {}),
}));
jest.mock("@/lib/derivations/resolve", () => ({
  listEnabledRunDetectors: jest.fn(async () => []),
}));
jest.mock("../live", () => ({ isRunningNow: jest.fn(async () => true) }));

import { mintPoint, findPointByStemMetric } from "@/lib/point/mint-point";
import {
  refreshServingForMintedPoints,
  updateLatestPointValue,
} from "@/lib/kv-cache-manager";
import { listEnabledRunDetectors } from "@/lib/derivations/resolve";
import { publishRunningLatest } from "../running-latest";

const mockMint = jest.mocked(mintPoint);
const mockFind = jest.mocked(findPointByStemMetric);
const mockRefresh = jest.mocked(refreshServingForMintedPoints);
const mockLatest = jest.mocked(updateLatestPointValue);
const mockDetectors = jest.mocked(listEnabledRunDetectors);

const POINT = {
  index: 168,
  rid: 168,
  pointUid: "019f0000-0000-7000-8000-000000000168",
};

const detector = {
  id: "dx-1",
  legacyHandle: 6,
  role: "ev",
  name: "EV charging",
};

let order: string[];

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  mockDetectors.mockResolvedValue([detector] as never);
  mockRefresh.mockImplementation(async () => {
    order.push("refresh");
  });
  mockLatest.mockImplementation(async () => {
    order.push("publish");
  });
});

describe("publishRunningLatest — serving refresh", () => {
  it("rebuilds serving on a fresh mint, before the first value is published", async () => {
    mockFind.mockResolvedValue(null);
    mockMint.mockResolvedValue(POINT as never);

    await publishRunningLatest(1731627600000);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // Publishing first would leave the point's first state in the device hash only.
    expect(order).toEqual(["refresh", "publish"]);
  });

  it("does not rebuild when the running point already exists (the minutely case)", async () => {
    mockFind.mockResolvedValue(POINT as never);

    await publishRunningLatest(1731627600000);

    expect(mockMint).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(order).toEqual(["publish"]);
  });
});
