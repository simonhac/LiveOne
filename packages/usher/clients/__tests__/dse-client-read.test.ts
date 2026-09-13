import { DseClient, REGISTERS } from "../dse-client";

const mockRead = jest.fn();
jest.mock("modbus-serial", () => ({
  __esModule: true,
  default: class {
    setID() {}
    setTimeout() {}
    async connectTCP() {}
    readHoldingRegisters(base: number, count: number) {
      return mockRead(base, count);
    }
    close(cb: () => void) {
      cb();
    }
    destroy(cb: () => void) {
      cb();
    }
  },
}));
const hybrid = [
  "plantBatterySoc",
  "loadKwh",
  "batteryChargeKwh",
  "batteryDischargeKwh",
];
let model: number;
let manufacturer: number;
let failAddress: number | undefined;
beforeEach(() => {
  model = 0x804d;
  manufacturer = 1;
  failAddress = undefined;
  mockRead
    .mockReset()
    .mockImplementation(async (base: number, count: number) => {
      const data: number[] = [];
      for (let address = base; address < base + count; address++) {
        const field = REGISTERS.find(
          (r) => address >= r.address && address < r.address + r.words,
        );
        if (!field) throw Error("Modbus exception 0: unmapped hole");
        if (address === failAddress) throw Error("Modbus timeout");
        if (hybrid.includes(field.key))
          throw Error("Modbus exception 1: Illegal function");
        data.push(
          field.key === "modelNumber"
            ? model
            : field.key === "manufacturerCode"
              ? manufacturer
              : 0,
        );
      }
      return { data };
    });
});
it("reads mapped words without holes and explicitly excludes only the qualified hybrid fields", async () => {
  const dump = await new DseClient({ host: "192.0.2.1" }).readAll();
  expect(dump.pageErrors).toEqual([]);
  expect(dump.readings).toHaveLength(REGISTERS.length);
  expect(dump.readings.filter((r) => r.error)).toEqual([]);
  expect(
    dump.readings.filter((r) => r.unsupported).map((r) => r.field.key),
  ).toEqual(hybrid);
  for (const r of dump.readings.filter((r) => r.unsupported)) {
    expect(r).toMatchObject({ rawWords: [], rawInt: null, value: null });
  }
  expect(dump.readings.find((r) => r.field.key === "batteryV")?.value).toBe(0);
});
it.each(["model", "manufacturer", "identity failure"])(
  "does not apply exclusions to an unknown %s",
  async (kind) => {
    if (kind === "model") model = 123;
    if (kind === "manufacturer") manufacturer = 2;
    if (kind === "identity failure") failAddress = 769;
    const dump = await new DseClient({ host: "192.0.2.1" }).readAll();
    expect(dump.readings.filter((r) => r.unsupported)).toEqual([]);
    expect(
      dump.readings
        .filter((r) => hybrid.includes(r.field.key))
        .every((r) => r.error),
    ).toBe(true);
  },
);
it("keeps genuine failures on supported registers visible", async () => {
  failAddress = 1029;
  const dump = await new DseClient({ host: "192.0.2.1" }).readAll();
  expect(dump.pageErrors.length).toBeGreaterThan(0);
  expect(dump.readings.find((r) => r.field.key === "batteryV")).toMatchObject({
    error: "Modbus timeout",
    value: null,
  });
});
