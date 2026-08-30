import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const updateUserMetadata = jest.fn(async () => ({}));
const updateUser = jest.fn(async () => ({}));
const getUser = jest.fn(async () => ({
  username: "probe",
  emailAddresses: [{ emailAddress: "probe@example.com" }],
  privateMetadata: {},
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { updateUserMetadata, updateUser, getUser },
  }),
  auth: async () => ({ userId: null }),
}));

import {
  storeDeviceCredentials,
  removeDeviceCredentials,
} from "../secure-credentials";

describe("vendor credential writes preserve sibling metadata keys", () => {
  beforeEach(() => {
    updateUserMetadata.mockClear();
    updateUser.mockClear();
  });

  // 🛑 THE REGRESSION. `updateUser` is PATCH /users/{id}, which REPLACES privateMetadata; this
  // module builds `{version, credentials}` from scratch, so using it deleted `cliTokens` — the
  // operator CLI's credential — on every vendor token refresh, logging the CLI out a few times a
  // day. `updateUserMetadata` (PATCH /users/{id}/metadata) merges top-level keys instead.
  it("stores credentials via the MERGING endpoint, never the replacing one", async () => {
    getUser.mockResolvedValueOnce({
      username: "probe",
      emailAddresses: [{ emailAddress: "probe@example.com" }],
      privateMetadata: {
        version: "1.1",
        credentials: [],
        cliTokens: [{ id: "cli_x" }],
      },
    } as never);

    await storeDeviceCredentials("user_1", 7, "tesla", {
      access_token: "a",
    } as never);

    expect(updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(updateUser).not.toHaveBeenCalled();
    // Only the keys this module owns are written — and because the endpoint merges, whatever else
    // lives in privateMetadata (cliTokens) survives.
    const written = (updateUserMetadata.mock.calls[0] as unknown[])[1] as {
      privateMetadata: Record<string, unknown>;
    };
    expect(Object.keys(written.privateMetadata).sort()).toEqual([
      "credentials",
      "version",
    ]);
  });

  it("removes credentials via the MERGING endpoint too", async () => {
    getUser.mockResolvedValueOnce({
      username: "probe",
      emailAddresses: [{ emailAddress: "probe@example.com" }],
      privateMetadata: {
        version: "1.1",
        credentials: [{ systemId: 7 }],
        cliTokens: [{ id: "cli_x" }],
      },
    } as never);

    await removeDeviceCredentials("user_1", 7);

    expect(updateUserMetadata).toHaveBeenCalledTimes(1);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("has no `updateUser(` metadata write left in the module", () => {
    // A grep-level guard: the mocked tests above only cover the two paths they drive, and the
    // failure mode is silent (a wiped credential, discovered hours later by a 401).
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/secure-credentials.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/users\.updateUser\(/);
  });
});
