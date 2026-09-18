import { EXIT, failWith, str, num, type Ctx } from "@/lib/cli/cli";
import {
  connect,
  Portal,
  selectDevice,
  type Channel,
  type PortalCredentials,
  validateCredentials,
} from "@/lib/selectlive/transport";
import {
  Inverter,
  deviceInfo,
  wordsFrom,
  request,
} from "@/lib/selectlive/protocol";
import {
  credentialPath,
  readCredentials,
  saveCredentials,
  forgetCredentials,
  environmentCredentials,
  portalCredentials,
  inverterPassword,
  prompt,
  type Environment,
} from "@/lib/selectlive/credentials";
import {
  coverage,
  downloadHistory,
  logMetadata,
  readBatches,
  supportedFormat,
  validateDownloadOptions,
} from "@/lib/selectlive/history";
import {
  EVENT_LOG_NAMES,
  eventLogMetadata,
  supportedEventFormat,
  toEventRecord,
  type EventLog,
} from "@/lib/selectlive/events";
import {
  downloadEvents,
  validateEventDownloadOptions,
  type EventDownloadOptions,
} from "@/lib/selectlive/event-download";
import { SelectLiveError } from "@/lib/selectlive/errors";

export interface Dependencies {
  env: Environment;
  storePath: string;
  connect: (signal?: AbortSignal) => Promise<Channel>;
  prompt: typeof prompt;
}
export const dependencies = (): Dependencies => ({
  env: process.env,
  storePath: credentialPath(),
  connect,
  prompt,
});

export async function executeSelectlive(
  ctx: Ctx,
  deps = dependencies(),
  signal?: AbortSignal,
): Promise<number> {
  const command = ctx.subcommandPath[0];
  const action = String(ctx.args[0] ?? "login");
  const explicitSerial = str(ctx, "device");
  if (command === "auth") {
    if (!["login", "status", "logout"].includes(action))
      throw new SelectLiveError(
        "usage",
        "auth accepts login (default), status, or logout.",
      );
    if (explicitSerial && action !== "login")
      throw new SelectLiveError(
        "usage",
        "--device is only supported by selectlive auth login.",
      );
    if (action === "logout") {
      forgetCredentials(deps.storePath);
      ctx.emit(
        { authenticated: false, removed: true },
        () =>
          "Removed saved Select.live credentials. Environment overrides, if set, still apply.",
      );
      return EXIT.OK;
    }
  }
  const downloadOptions = {
    out: str(ctx, "out") ?? "",
    timezone: str(ctx, "timezone"),
    start: str(ctx, "start"),
    end: str(ctx, "end"),
    signal,
    progress: (done: number, total: number) => {
      if (done === total || done % 100 < 6)
        ctx.note(`Downloaded ${done}/${total} records.`);
    },
  };
  if (command === "history" && ctx.subcommandPath[1] === "download")
    validateDownloadOptions(downloadOptions);
  const requestedLog = str(ctx, "kind") ?? "both";
  const eventDownloadOptions: EventDownloadOptions = {
    out: str(ctx, "out") ?? "",
    logs:
      requestedLog === "both" ? EVENT_LOG_NAMES : [requestedLog as EventLog],
    timezone: str(ctx, "timezone"),
    start: str(ctx, "start"),
    end: str(ctx, "end"),
    resume: str(ctx, "resume"),
    signal,
    progress: (log, done, total) =>
      ctx.note(`${log}: ${done}/${total} records.`),
  };
  // Validate before opening a socket: a mistyped timezone must not cost an inverter session.
  if (command === "events" && ctx.subcommandPath[1] === "download")
    validateEventDownloadOptions(eventDownloadOptions);
  if (command === "read")
    request("Q", Number(str(ctx, "address")), num(ctx, "words")!);
  const stored = readCredentials(deps.storePath);
  let credentials: PortalCredentials;
  if (command === "auth" && action === "status") {
    if (!stored)
      throw new SelectLiveError(
        "auth",
        "No saved account. Run selectlive auth.",
      );
    credentials = stored;
  } else if (command === "auth") {
    credentials =
      environmentCredentials(deps.env) ??
      (explicitSerial && stored
        ? stored
        : {
            email: await deps.prompt("Select.live email: ", false, signal),
            password: await deps.prompt("Select.live password: ", true, signal),
          });
  } else credentials = portalCredentials(stored, deps.env);
  // Validate secrets before opening a socket; protocol login validates them again for callers.
  validateCredentials(credentials);
  const portal = new Portal(await deps.connect(signal));
  try {
    await portal.login(credentials);
    if (command === "auth" && action === "status") {
      ctx.emit(
        {
          authenticated: true,
          email: credentials.email,
          savedInverterSerials: Object.keys(stored!.inverterPasswords),
        },
        (value) => `Authenticated as ${(value as { email: string }).email}.`,
      );
      return EXIT.OK;
    }
    if (command === "auth" && !explicitSerial) {
      saveCredentials(
        {
          version: 1,
          ...credentials,
          inverterPasswords:
            stored?.email === credentials.email ? stored.inverterPasswords : {},
        },
        deps.storePath,
      );
      ctx.emit(
        { authenticated: true, email: credentials.email, saved: true },
        () => `Authenticated as ${credentials.email}; credentials saved.`,
      );
      return EXIT.OK;
    }
    const devices = await portal.devices();
    if (command === "devices") {
      ctx.emit({ devices }, () =>
        devices.length
          ? devices.map((d) => d.serial).join("\n")
          : "No inverters available.",
      );
      return devices.length ? EXIT.OK : EXIT.FINDINGS;
    }
    const serial = selectDevice(devices, explicitSerial);
    ctx.note(`Inverter: ${serial}`);
    // Prompt before claiming the inverter session.
    const password =
      command === "auth"
        ? (deps.env.SELECTLIVE_INVERTER_PASSWORD ??
          (await deps.prompt(
            "Inverter password (factory default: Selectronic SP PRO): ",
            true,
            signal,
          )))
        : inverterPassword(serial, credentials, stored, deps.env);
    await portal.select(serial);
    const inverter = new Inverter(portal.channel);
    await inverter.login(password);
    if (command === "auth") {
      saveCredentials(
        {
          version: 1,
          ...credentials,
          inverterPasswords: {
            ...(stored?.email === credentials.email
              ? stored.inverterPasswords
              : {}),
            [serial]: password,
          },
        },
        deps.storePath,
      );
      ctx.emit(
        { authenticated: true, email: credentials.email, serial, saved: true },
        () => `Portal and inverter ${serial} authenticated; credentials saved.`,
      );
      return EXIT.OK;
    }
    if (command === "read") {
      const address = Number(str(ctx, "address"));
      const bytes = await inverter.query(address, num(ctx, "words")!);
      ctx.emit(
        {
          serial,
          address,
          addressHex: `0x${address.toString(16)}`,
          words: wordsFrom(bytes),
          hex: bytes.toString("hex"),
        },
        () =>
          `Inverter ${serial} @ 0x${address.toString(16)}\n${bytes.toString("hex")}\n${wordsFrom(bytes).join(" ")}`,
      );
      return EXIT.OK;
    }
    const info = await deviceInfo(inverter);
    if (BigInt(info.serial) !== BigInt(serial))
      throw new SelectLiveError(
        "protocol",
        "Connected inverter identity differs from the requested serial.",
      );
    if (command === "events") {
      if (ctx.subcommandPath[1] === "download") {
        const manifest = await downloadEvents(
          inverter,
          info,
          eventDownloadOptions,
        );
        // 🛑 `lost` only. `unverified` means the walk stopped before reaching the anchor — a
        // deadline or an abort — which says nothing about whether those records still exist.
        // Reporting it as loss would announce permanent data loss on no evidence.
        const lostOverlap = Object.values(manifest.logs).some(
          (l) => l.overlapVerdict === "lost",
        );
        ctx.emit(manifest, () => {
          const overlap = (verdict: string | undefined) =>
            verdict === "confirmed"
              ? ", overlap confirmed"
              : verdict === "lost"
                ? ", overlap LOST — those records were overwritten between captures and are gone"
                : verdict === "unverified"
                  ? ", overlap NOT VERIFIED — the walk stopped before reaching the anchor; retry"
                  : "";
          const lines = Object.entries(manifest.logs).map(([log, l]) =>
            l.attempted
              ? `${log}: ${l.acquiredRecords} records (${l.stoppedBecause})` +
                overlap(l.overlapVerdict)
              : // Never reached — the run stopped before this log. Its inherited anchor is still in
                // the manifest, so the next --resume picks up where the last good one left off.
                `${log}: not read${l.anchor ? " (previous anchor carried forward)" : ""}`,
          );
          return [
            `Saved to ${manifest.directory}`,
            ...lines,
            `Acquisition: ${manifest.complete ? "complete" : "incomplete"}; CSV: ${manifest.decoding}`,
            manifest.clock?.offsetSeconds != null
              ? `Device clock is ${manifest.clock.offsetSeconds.toFixed(1)}s behind ours (recorded, not applied).`
              : "",
            manifest.error ?? "",
          ]
            .filter(Boolean)
            .join("\n");
        });
        if (signal?.aborted) return EXIT.INTERRUPTED;
        return manifest.complete &&
          manifest.decoding === "decoded" &&
          !lostOverlap
          ? EXIT.OK
          : EXIT.FINDINGS;
      }
      // events info: descriptors plus the oldest/newest record actually present, which the record
      // COUNT alone does not give you — a log can advertise 52 records spanning a year.
      const logs: Record<string, unknown> = {};
      let stable = true;
      for (const log of EVENT_LOG_NAMES) {
        const before = await eventLogMetadata(inverter, log);
        const supported = supportedEventFormat(
          info.versions.events,
          before.entryWords,
        );
        let oldest: string | null = null;
        let newest: string | null = null;
        if (before.recordCount && supported) {
          const batches = [...readBatches(before)];
          const at = async (address: number) =>
            toEventRecord(
              log,
              address,
              (await inverter.query(address, before.entryWords)).toString(
                "hex",
              ),
            ).deviceTime;
          newest = await at(before.currentAddress);
          oldest = await at(batches[batches.length - 1].address);
          stable &&=
            JSON.stringify(before) ===
            JSON.stringify(await eventLogMetadata(inverter, log));
        }
        logs[log] = {
          metadata: before,
          supportedDecoding: supported,
          oldestDeviceTime: oldest,
          newestDeviceTime: newest,
        };
      }
      ctx.emit(
        { device: info, eventLogs: logs, snapshotStable: stable },
        (value) => JSON.stringify(value, null, 2),
      );
      return stable ? EXIT.OK : EXIT.FINDINGS;
    }
    if (command === "history" && ctx.subcommandPath[1] === "download") {
      const acquisition = await downloadHistory(
        inverter,
        info,
        downloadOptions,
      );
      ctx.emit(
        acquisition,
        () =>
          `${acquisition.acquiredRecords}/${acquisition.before.recordCount} records saved to ${acquisition.directory}\nAcquisition: ${acquisition.complete ? "complete" : "incomplete"}; CSV: ${acquisition.decoding}${acquisition.error ? `\n${acquisition.error}` : ""}`,
      );
      if (signal?.aborted) return EXIT.INTERRUPTED;
      return acquisition.complete && acquisition.decoding === "decoded"
        ? EXIT.OK
        : EXIT.FINDINGS;
    }
    const log = await logMetadata(inverter);
    let availableCoverage: ReturnType<typeof coverage> = null;
    let snapshotStable = true;
    if (
      command === "history" &&
      log.recordCount &&
      supportedFormat(info.versions.detailed, log.entryWords)
    ) {
      const batches = [...readBatches(log)];
      const addresses = [
        log.currentAddress,
        batches[batches.length - 1].address,
      ];
      const records = [];
      for (const address of addresses)
        records.push({
          address,
          hex: (await inverter.query(address, 2)).toString("hex"),
        });
      snapshotStable =
        JSON.stringify(log) === JSON.stringify(await logMetadata(inverter));
      if (snapshotStable) availableCoverage = coverage(records);
    }
    ctx.emit(
      {
        device: info,
        detailedLog: log,
        supportedDecoding: supportedFormat(
          info.versions.detailed,
          log.entryWords,
        ),
        coverage: availableCoverage,
        snapshotStable,
      },
      (value) => JSON.stringify(value, null, 2),
    );
    return snapshotStable ? EXIT.OK : EXIT.FINDINGS;
  } finally {
    portal.close();
  }
}

export async function runSelectlive(ctx: Ctx): Promise<number> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    return await executeSelectlive(ctx, dependencies(), controller.signal);
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof SelectLiveError && error.kind === "interrupted")
    )
      return EXIT.INTERRUPTED;
    if (error instanceof SelectLiveError) {
      const code =
        error.kind === "usage"
          ? EXIT.USAGE
          : error.kind === "auth"
            ? EXIT.AUTH
            : EXIT.UPSTREAM;
      throw failWith(
        code,
        error.message,
        `Select.live ${error.kind} failure`,
        code === EXIT.AUTH
          ? "run selectlive auth (add --device SERIAL for the inverter password)"
          : "run selectlive --help; retry after resolving the reported issue",
      );
    }
    // No raw exceptions from libraries: upstream messages may contain sensitive payloads.
    throw failWith(
      EXIT.UPSTREAM,
      "Select.live operation failed.",
      "A local file or connection operation failed.",
      "Check output/store permissions and connectivity, then retry.",
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
