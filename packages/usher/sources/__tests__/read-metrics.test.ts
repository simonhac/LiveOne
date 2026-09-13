import { createMusher } from "../musher";
const mockFinish = jest.fn();
const mockBegin = jest.fn((..._args: unknown[]) => mockFinish);
let mockDump: any = {
  readings: [{ field: { key: "engineRpm" }, value: 0, rawWords: [0] }],
  pageErrors: [],
};
let mockClose: () => Promise<void> = async () => {};
jest.mock("../../core/read-metrics", () => ({
  beginProductionRead: (...args: unknown[]) => mockBegin(...args),
}));
jest.mock("../../clients/dse-client", () => ({
  ...jest.requireActual("../../clients/dse-client"),
  DseClient: class {
    async readAll() {
      return mockDump;
    }
    async close() {
      await mockClose();
    }
  },
}));
beforeEach(() => {
  mockFinish.mockClear();
  mockBegin.mockClear();
  mockClose = async () => {};
  mockDump = {
    readings: [{ field: { key: "engineRpm" }, value: 0, rawWords: [0] }],
    pageErrors: [],
  };
});
const telemetry = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  readerId: "22222222-2222-4222-8222-222222222222",
};
it("finishes only after cleanup and does not classify zero as missing", async () => {
  let release!: () => void;
  mockClose = () =>
    new Promise<void>((r) => {
      release = r;
    });
  const pending = createMusher({ siteId: "synthetic", telemetry }).read();
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  expect(mockBegin).toHaveBeenCalledWith({ ...telemetry, vendor: "deepsea" });
  expect(mockFinish).not.toHaveBeenCalled();
  release();
  await pending;
  expect(mockFinish.mock.calls[0][0]).toBe("success");
});
it("reports page errors as partial without changing the returned data", async () => {
  mockDump.pageErrors = [{ page: 1, error: "private detail" }];
  expect(
    await createMusher({ siteId: "synthetic", telemetry }).read(),
  ).toMatchObject({ engineRpm: 0 });
  expect(mockFinish).toHaveBeenCalledWith("partial", {
    kind: "device_error",
    code: undefined,
  });
});
it("does not treat an unsupported sentinel as an error when other data is valid", async () => {
  mockDump.readings.push({
    field: { key: "oilTempC" },
    value: null,
    rawWords: [65535],
  });
  await createMusher({ siteId: "synthetic", telemetry }).read();
  expect(mockFinish.mock.calls[0][0]).toBe("success");
});
it("records success with explicit unsupported fields but preserves real field errors", async () => {
  mockDump.readings.push({
    field: { key: "loadKwh" },
    value: null,
    rawWords: [],
    unsupported: "qualified model exclusion",
  });
  await createMusher({ siteId: "synthetic", telemetry }).read();
  expect(mockFinish.mock.calls[0][0]).toBe("success");
  mockDump.readings.push({
    field: { key: "batteryV" },
    value: null,
    rawWords: [],
    error: "timeout",
  });
  await createMusher({ siteId: "synthetic", telemetry }).read();
  expect(mockFinish.mock.calls[1][0]).toBe("partial");
});
