import { beforeEach, describe, it, expect, jest } from "@jest/globals";
import { Device } from "@/lib/ids";

jest.mock("@/lib/areas/list", () => ({
  listReadableAreas: jest.fn(),
}));
jest.mock("@/lib/devices/list", () => ({
  listReadableDevices: jest.fn(),
}));

import { listReadableAreas } from "@/lib/areas/list";
import { listReadableDevices } from "@/lib/devices/list";
import { checkDocRefsReadable, parseIfMatch } from "../v4-routes";

const mockAreas = jest.mocked(listReadableAreas);
const mockDevices = jest.mocked(listReadableDevices);

describe("parseIfMatch", () => {
  it('parses a quoted revision (`"17"`)', () => {
    expect(parseIfMatch('"17"')).toEqual({ kind: "revision", revision: 17 });
  });
  it("parses a bare revision", () => {
    expect(parseIfMatch("17")).toEqual({ kind: "revision", revision: 17 });
    expect(parseIfMatch(" 42 ")).toEqual({ kind: "revision", revision: 42 });
  });
  it("distinguishes a missing header from every malformed present value", () => {
    expect(parseIfMatch(null)).toEqual({ kind: "absent" });
    for (const value of [
      "",
      "not-a-number",
      "17junk",
      'W/"17"',
      "*",
      "17, 18",
      "0",
      "-1",
      "9007199254740992",
      '""17""',
    ]) {
      expect(parseIfMatch(value)).toEqual({ kind: "invalid" });
    }
  });
});

describe("checkDocRefsReadable", () => {
  beforeEach(() => {
    mockAreas.mockReset();
    mockDevices.mockReset();
    mockAreas.mockResolvedValue([]);
    mockDevices.mockResolvedValue([]);
  });

  it("accepts a directly referenced readable device", async () => {
    const device = Device.generate();
    mockDevices.mockResolvedValue([
      {
        id: device,
        name: "Device",
        systemId: 7,
        vendor: "test",
        status: "active",
      },
    ]);
    await expect(
      checkDocRefsReadable(
        {
          version: 4,
          root: {
            kind: "group",
            children: [{ kind: "card", type: "solar", device }],
          },
        },
        "owner",
      ),
    ).resolves.toBeNull();
  });

  it("rejects a syntactically valid fake device with the same non-revealing 403", async () => {
    const response = await checkDocRefsReadable(
      {
        version: 4,
        root: {
          kind: "group",
          children: [
            {
              kind: "card",
              type: "solar",
              device: Device.generate(),
            },
          ],
        },
      },
      "owner",
    );
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "The doc references an area or device you cannot read",
    });
  });
});
