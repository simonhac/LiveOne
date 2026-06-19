jest.mock("../kv", () => ({
  kv: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
  kvKey: jest.fn((pattern: string) => `test:${pattern}`),
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn(),
}));

import { clerkClient } from "@clerk/nextjs/server";
import { kv } from "../kv";
import { getUserIdByUsername } from "../user-cache";

const mockClerkClient = jest.mocked(clerkClient);
const mockKv = kv as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
};

function mockClerkUsers({
  getUser = jest.fn(),
  getUserList = jest.fn(),
}: {
  getUser?: jest.Mock;
  getUserList?: jest.Mock;
}) {
  mockClerkClient.mockResolvedValue({
    users: {
      getUser,
      getUserList,
    },
  } as any);
  return { getUser, getUserList };
}

describe("user-cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a cached username mapping after verifying it still matches Clerk", async () => {
    mockKv.get.mockResolvedValue({
      clerkId: "user_1",
      lastUpdatedTimeMs: 1,
    });
    const { getUser, getUserList } = mockClerkUsers({
      getUser: jest.fn().mockResolvedValue({
        id: "user_1",
        username: "simon",
      }),
      getUserList: jest.fn(),
    });

    await expect(getUserIdByUsername("simon")).resolves.toBe("user_1");

    expect(getUser).toHaveBeenCalledWith("user_1");
    expect(getUserList).not.toHaveBeenCalled();
    expect(mockKv.del).not.toHaveBeenCalled();
    expect(mockKv.set).not.toHaveBeenCalled();
  });

  it("invalidates a cached mapping when the cached user no longer has that username", async () => {
    mockKv.get.mockResolvedValue({
      clerkId: "user_old",
      lastUpdatedTimeMs: 1,
    });
    const { getUser, getUserList } = mockClerkUsers({
      getUser: jest.fn().mockResolvedValue({
        id: "user_old",
        username: "renamed",
      }),
      getUserList: jest.fn().mockResolvedValue({
        data: [{ id: "user_new", username: "simon" }],
      }),
    });

    await expect(getUserIdByUsername("simon")).resolves.toBe("user_new");

    expect(getUser).toHaveBeenCalledWith("user_old");
    expect(mockKv.del).toHaveBeenCalledWith("test:username:simon");
    expect(getUserList).toHaveBeenCalledWith({ username: ["simon"] });
    expect(mockKv.set).toHaveBeenCalledWith(
      "test:username:simon",
      expect.objectContaining({ clerkId: "user_new" }),
    );
  });

  it("caches a Clerk lookup when no username mapping exists", async () => {
    mockKv.get.mockResolvedValue(null);
    const { getUser, getUserList } = mockClerkUsers({
      getUser: jest.fn(),
      getUserList: jest.fn().mockResolvedValue({
        data: [{ id: "user_1", username: "simon" }],
      }),
    });

    await expect(getUserIdByUsername("simon")).resolves.toBe("user_1");

    expect(getUser).not.toHaveBeenCalled();
    expect(getUserList).toHaveBeenCalledWith({ username: ["simon"] });
    expect(mockKv.set).toHaveBeenCalledWith(
      "test:username:simon",
      expect.objectContaining({ clerkId: "user_1" }),
    );
  });
});
