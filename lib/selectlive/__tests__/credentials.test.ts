import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  credentialPath,
  environmentCredentials,
  forgetCredentials,
  inverterPassword,
  portalCredentials,
  prompt,
  readCredentials,
  saveCredentials,
} from "../credentials";

const saved = {
  version: 1 as const,
  email: "test@example.com",
  password: "portal-secret",
  inverterPasswords: { "123": "inverter-secret" },
};
let root: string;
let file: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "selectlive-test-"));
  file = path.join(root, "selectlive", "credentials.json");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it("uses XDG_CONFIG_HOME and writes private files atomically", () => {
  expect(credentialPath({ XDG_CONFIG_HOME: root })).toBe(file);
  expect(readCredentials(file)).toBeUndefined();
  saveCredentials(saved, file);
  expect(readCredentials(file)).toEqual(saved);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  saveCredentials({ ...saved, password: "replacement" }, file);
  expect(readCredentials(file)?.password).toBe("replacement");
  expect(fs.readdirSync(path.dirname(file))).toEqual(["credentials.json"]);
  forgetCredentials(file);
  expect(readCredentials(file)).toBeUndefined();
});
it("rejects unsafe permissions, invalid files, and symlinks without echoing contents", () => {
  saveCredentials(saved, file);
  fs.chmodSync(file, 0o644);
  expect(() => readCredentials(file)).toThrow(/private regular file/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "secret-invalid-json");
  expect(() => readCredentials(file)).toThrow(
    "Cannot read the Select.live credential store; repair or remove it and run selectlive auth.",
  );
  fs.rmSync(file);
  fs.writeFileSync(path.join(root, "target"), JSON.stringify(saved));
  fs.symlinkSync(path.join(root, "target"), file);
  expect(() => readCredentials(file)).toThrow(/private regular file/);
});
it("requires an environment credential pair and isolates per-account inverter passwords", () => {
  expect(() =>
    environmentCredentials({ SELECTLIVE_EMAIL: "test@example.com" }),
  ).toThrow(/both/);
  expect(() =>
    environmentCredentials({ SELECTLIVE_PASSWORD: "secret" }),
  ).toThrow(/both/);
  expect(portalCredentials(saved, {}).password).toBe("portal-secret");
  expect(inverterPassword("123", saved, saved, {})).toBe("inverter-secret");
  expect(
    inverterPassword(
      "123",
      { ...saved, email: "other@example.com" },
      saved,
      {},
    ),
  ).toBe("Selectronic SP PRO");
  expect(
    inverterPassword("123", saved, saved, {
      SELECTLIVE_INVERTER_PASSWORD: "override",
    }),
  ).toBe("override");
  expect(() =>
    environmentCredentials({
      SELECTLIVE_EMAIL: "bad\nemail",
      SELECTLIVE_PASSWORD: "secret",
    }),
  ).toThrow(/control/);
});
it("refuses noninteractive prompts rather than hanging", async () => {
  await expect(prompt("Password: ", true)).rejects.toMatchObject({
    kind: "usage",
  });
});
