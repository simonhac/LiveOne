import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { amberDeviceName, readAmberIdentity } from "../device-name";

afterEach(() => {
  jest.restoreAllMocks();
});

describe("Amber identity", () => {
  it("preserves NMI leading zeros and distributor spaces", () => {
    expect(
      amberDeviceName({ network: "United Energy", nmi: "0123456789" }),
    ).toBe("Amber United Energy NMI 0123456789");
  });
  it("selects the stored site even if another site appears first", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "other", network: "Other", nmi: "111" },
          { id: "stored", network: "CitiPower", nmi: "0123456789" },
        ]),
      ),
    );
    expect(await readAmberIdentity("secret", "stored")).toEqual({
      vendorSiteId: "stored",
      distributor: "CitiPower",
      nmi: "0123456789",
      suggestedName: "Amber CitiPower NMI 0123456789",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.amber.com.au/v1/sites",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });
  it.each([
    [],
    [{ id: "other", network: "CitiPower", nmi: "123" }],
    [{ id: "stored", network: "", nmi: "123" }],
    [{ id: "stored", network: "CitiPower", nmi: 123 }],
    {},
  ])("refuses absent or malformed identity: %p", async (sites) => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(sites)));
    await expect(readAmberIdentity("secret", "stored")).rejects.toThrow();
  });
  it("does not echo the upstream error body", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("sensitive", { status: 401 }));
    await expect(readAmberIdentity("secret", "stored")).rejects.toThrow(
      "Amber identity request failed (401)",
    );
  });
});
