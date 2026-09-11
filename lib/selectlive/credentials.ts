import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { SelectLiveError } from "./errors";
import { validateCredentials, type PortalCredentials } from "./transport";

const schema = z.object({
  version: z.literal(1),
  email: z.string().min(1),
  password: z.string().min(1),
  inverterPasswords: z.record(z.string(), z.string()),
});
export type Credentials = z.infer<typeof schema>;
export type Environment = Readonly<Record<string, string | undefined>>;
export function credentialPath(env: Environment = process.env): string {
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "selectlive",
    "credentials.json",
  );
}
export function readCredentials(
  file = credentialPath(),
): Credentials | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) {
      throw new SelectLiveError(
        "auth",
        "Credential store must be a private regular file (chmod 600).",
      );
    }
    const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) throw new Error("Invalid credential file");
    validateCredentials(parsed.data);
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SelectLiveError) throw error;
    throw new SelectLiveError(
      "auth",
      "Cannot read the Select.live credential store; repair or remove it and run selectlive auth.",
    );
  }
}
export function saveCredentials(
  value: Credentials,
  file = credentialPath(),
): void {
  const validated = schema.parse(value);
  validateCredentials(validated);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink())
    throw new SelectLiveError(
      "auth",
      "Credential directory must not be a symbolic link.",
    );
  fs.chmodSync(dir, 0o700);
  const temporary = path.join(dir, `.credentials-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(validated, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function forgetCredentials(file = credentialPath()): void {
  fs.rmSync(file, { force: true });
}
export function environmentCredentials(
  env: Environment = process.env,
): PortalCredentials | undefined {
  if (
    env.SELECTLIVE_EMAIL === undefined &&
    env.SELECTLIVE_PASSWORD === undefined
  )
    return undefined;
  if (!env.SELECTLIVE_EMAIL || !env.SELECTLIVE_PASSWORD)
    throw new SelectLiveError(
      "usage",
      "Set both SELECTLIVE_EMAIL and SELECTLIVE_PASSWORD when overriding portal credentials.",
    );
  const value = {
    email: env.SELECTLIVE_EMAIL,
    password: env.SELECTLIVE_PASSWORD,
  };
  validateCredentials(value);
  return value;
}
export function portalCredentials(
  stored: Credentials | undefined,
  env: Environment = process.env,
): PortalCredentials {
  const value = environmentCredentials(env) ?? stored;
  if (!value)
    throw new SelectLiveError(
      "auth",
      "No Select.live credentials. Run selectlive auth first.",
    );
  return value;
}
export function inverterPassword(
  serial: string,
  portal: PortalCredentials,
  stored: Credentials | undefined,
  env: Environment = process.env,
): string {
  return (
    env.SELECTLIVE_INVERTER_PASSWORD ??
    (stored?.email === portal.email
      ? stored.inverterPasswords[serial]
      : undefined) ??
    "Selectronic SP PRO"
  );
}

/** Prompt on the terminal only; never echo or place a password in argv. */
export async function prompt(
  label: string,
  secret: boolean,
  signal?: AbortSignal,
): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new SelectLiveError(
      "usage",
      "No interactive terminal. Set SELECTLIVE_EMAIL and SELECTLIVE_PASSWORD (and SELECTLIVE_INVERTER_PASSWORD for inverter authentication).",
    );
  if (signal?.aborted)
    throw new SelectLiveError("interrupted", "Operation interrupted.");
  if (!secret) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return (await rl.question(label, { signal })).trim();
    } finally {
      rl.close();
    }
  }
  process.stderr.write(label);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    let finished = false;
    const finish = (error?: SelectLiveError) => {
      if (finished) return;
      finished = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () =>
      finish(new SelectLiveError("interrupted", "Operation interrupted."));
    const onEnd = () =>
      finish(
        new SelectLiveError(
          "usage",
          "Input closed before the password was entered.",
        ),
      );
    const onData = (data: Buffer) => {
      for (const char of decoder.write(data)) {
        if (char === "\x03" || char === "\x04") {
          onAbort();
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\x7f" || char === "\b")
          value = [...value].slice(0, -1).join("");
        else if (char >= " " && char !== "\x7f") value += char;
      }
    };
    input.on("data", onData);
    input.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
