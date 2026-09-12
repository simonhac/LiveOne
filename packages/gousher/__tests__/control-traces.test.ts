import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildControlTraces } from "../tools/control-traces";

it("pins shared simulator traces to the production TypeScript supervisor", async () => {
  const expected = JSON.parse(
    readFileSync(
      resolve(__dirname, "../internal/gousher/testdata/control-traces.json"),
      "utf8",
    ),
  );
  expect(await buildControlTraces()).toEqual(expected);
});
