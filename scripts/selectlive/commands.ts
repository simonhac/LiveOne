import { z } from "zod";
import {
  defineCommand,
  type CommandSpec,
  type FlagSpec,
  V,
} from "@/lib/cli/cli";

const device: Record<string, FlagSpec> = {
  device: {
    type: "string",
    help: "Inverter serial (required when the account has multiple devices)",
    schema: z.string().regex(/^\d+$/),
  },
};
// NO `when: spec.summary` DEFAULT. It reads as a convenience and is not one: `summary` and `when`
// answer different questions ("what is this" / "when do I reach for it"), they are weighted
// differently by `liveone find`'s ranking, and copying one into the other declares a routing
// sentence that was never written. It also made every command here score its one sentence at
// summary+when in a very short document, which is how `selectlive history info` came to outrank
// `liveone auth login` on the query "log in". A leaf with nothing more to say than its summary
// should say nothing; `when` is optional.
const leaf = (spec: CommandSpec) =>
  defineCommand({
    uses: ["selectlive"],
    ...spec,
  });
export const selectliveCommand = defineCommand({
  name: "selectlive",
  summary: "Explore an SP PRO inverter through Select.live.",
  when: "Authenticate, list inverters, inspect memory, read stored configuration, or preserve retained detailed history through the SP LINK tunnel.",
  description:
    "Independent of LiveOne's API and database. Device commands read data; only inverter authentication writes are permitted.\nCredentials are saved locally by auth. Downloads create a new local directory. Neither operation needs --apply.",
  uses: ["selectlive"],
  handlesInterrupt: true,
  localEffects:
    "auth updates local credentials; history, events and config downloads create local files. Inverter settings are only ever read, never changed.",
  examples: [
    "selectlive auth",
    "selectlive devices",
    "selectlive history download --device 123456 --out ./downloads --timezone Australia/Melbourne",
    "selectlive config show --device 123456",
  ],
  subcommands: {
    auth: leaf({
      name: "auth",
      summary:
        "Verify and save the portal login, inspect authentication, or forget credentials.",
      localEffects:
        "login/logout change the local credential file; status only verifies authentication.",
      args: [
        {
          name: "action",
          required: false,
          help: "login (default), status, or logout",
        },
      ],
      flags: device,
      description:
        "No action means login. Password input is hidden. Automation: SELECTLIVE_EMAIL and SELECTLIVE_PASSWORD.\n--device additionally verifies and saves the inverter password (or SELECTLIVE_INVERTER_PASSWORD).\nstatus verifies the saved portal account. logout removes the local store without contacting Select.live.\nStore: $XDG_CONFIG_HOME/selectlive/credentials.json, or ~/.config/selectlive/credentials.json (mode 600).",
      examples: [
        "selectlive auth",
        "selectlive auth --device 123456",
        "selectlive auth status",
        "selectlive auth logout",
      ],
    }),
    devices: leaf({
      name: "devices",
      summary: "List inverter serials accessible to the portal account.",
      description:
        "The legacy device-list protocol supplies serial numbers only; it does not report online status.",
      examples: ["selectlive devices"],
    }),
    info: leaf({
      name: "info",
      summary:
        "Read inverter identity, firmware, interface versions, and logging metadata.",
      flags: device,
      examples: ["selectlive info --device 123456"],
    }),
    read: leaf({
      name: "read",
      summary:
        "Read a bounded range of inverter memory without writing settings.",
      flags: {
        ...device,
        address: {
          type: "string",
          required: true,
          help: "Word address, in decimal or 0x hexadecimal",
          schema: z
            .string()
            .regex(/^(?:0x[0-9a-fA-F]+|\d+)$/)
            .refine((v) => Number(v) <= 0xffffffff),
        },
        words: {
          type: "number",
          required: true,
          help: "Number of 16-bit words (1–256)",
          schema: z.number().int().min(1).max(256),
        },
      },
      examples: ["selectlive read --device 123456 --address 0xa007 --words 6"],
    }),
    history: defineCommand({
      name: "history",
      summary: "Inspect or preserve the inverter's retained detailed log.",
      subcommands: {
        info: leaf({
          name: "info",
          summary:
            "Read detailed log metadata and the oldest/newest record timestamps.",
          flags: device,
          examples: ["selectlive history info --device 123456"],
        }),
        download: leaf({
          name: "download",
          summary:
            "Preserve the full detailed buffer and optionally decode it as CSV.",
          localEffects:
            "Creates a new acquisition directory containing raw records, a manifest, and optional CSV.",
          description:
            "Always acquires the complete retained buffer; start/end filter only the exported CSV.\nRaw records and manifest are preserved before decoding. CSV requires --timezone.\nUnknown formats, moving buffers, and conversion failures remain explicit in the manifest.\nTimestamps use the device's local clock (epoch 2001-01-01). DST ambiguity is rejected.\nEach invocation creates a fresh directory; existing downloads are never overwritten.",
          flags: {
            ...device,
            out: {
              type: "string",
              required: true,
              help: "Parent directory for the new acquisition",
              schema: z.string().min(1),
            },
            timezone: {
              type: "string",
              help: "Device clock's IANA timezone; required to produce CSV",
            },
            start: {
              type: "string",
              help: "Inclusive local start date (YYYY-MM-DD)",
              schema: V.date,
            },
            end: {
              type: "string",
              help: "Exclusive local end date (YYYY-MM-DD)",
              schema: V.date,
            },
          },
          exitCodes: {
            1: "raw download preserved, but incomplete, unsupported, or not decoded",
          },
          examples: [
            "selectlive history download --device 123456 --out ./downloads --timezone Australia/Melbourne --start 2026-09-10 --end 2026-09-11",
            "selectlive history download --device 123456 --out ./downloads",
          ],
        }),
      },
    }),
    config: defineCommand({
      name: "config",
      summary:
        "Inspect or preserve the inverter's stored configuration settings.",
      when: "You need to know what the inverter is actually SET to — charge targets, generator thresholds, shunt assignments, the logging interval — rather than what it measured.",
      description:
        "READ ONLY. These are the same five memory ranges SP LINK reads to fill its configuration tabs; nothing is written.\nSettings whose conversion has not been traced are reported with their raw words rather than guessed at.\nA configuration snapshot is also the context stored readings need later: shunt assignments decide what the DC channels mean, and the logging interval decides what a record covers.",
      subcommands: {
        show: leaf({
          name: "show",
          summary: "Read the configuration and print the settings.",
          description:
            "Prints a curated set by default — charging, battery, generator and logging — because the full map is around 750 settings.\n--all prints every setting the map names, including those awaiting a converter; it applies to JSON output too.\nExits 1 when anything could not be decoded, or when a re-read could not confirm the snapshot, so a script can tell a complete read from a partial one.",
          flags: {
            ...device,
            all: {
              type: "boolean",
              help: "Print every setting, not just the commonly useful ones",
            },
            raw: {
              type: "boolean",
              help: "Show raw words beside each decoded value (human output; JSON always carries them)",
            },
          },
          exitCodes: {
            1: "read succeeded, but some settings could not be decoded",
          },
          examples: [
            "selectlive config show --device 123456",
            "selectlive config show --device 123456 --all --raw",
          ],
        }),
        download: leaf({
          name: "download",
          summary:
            "Preserve the configuration as raw words, a manifest and CSV.",
          localEffects:
            "Creates a new acquisition directory containing raw blocks, a manifest, and CSVs.",
          description:
            "Raw words and their SHA-256 are written before any decoding, so a capture survives a decoder that fails.\nEvery block is read twice and compared: configuration should not change mid-read, and a snapshot mixing two states is not written.\nUnmapped words are exported too, so the capture states its own coverage rather than implying it.\nThis is a record for inspection, NOT a restore file, and nothing here can write to the inverter.\nEach invocation creates a fresh directory; existing downloads are never overwritten.",
          flags: {
            ...device,
            out: {
              type: "string",
              required: true,
              help: "Parent directory for the new acquisition",
              schema: z.string().min(1),
            },
          },
          exitCodes: {
            1: "raw blocks preserved, but incomplete, unstable, or not fully decoded",
          },
          examples: [
            "selectlive config download --device 123456 --out ./downloads",
          ],
        }),
      },
    }),
    events: defineCommand({
      name: "events",
      summary:
        "Inspect or preserve the inverter's own alert and operational event logs.",
      when: "A fault, an outage, or a generator start you cannot explain from the portal — these logs record the event and an electrical snapshot taken with it.",
      description:
        "A DIFFERENT dataset from `history`, which is periodic measurement history (15-minute averages).\nThere are two logs: `alert` (faults) and `operational` (state changes). Both are read; --kind narrows.\nDuring the September 2026 Daylesford interruptions the portal's fault_code read zero throughout while these logs held the codes that explained them.",
      subcommands: {
        info: leaf({
          name: "info",
          summary:
            "Read both event logs' metadata and their oldest/newest record timestamps.",
          flags: device,
          examples: ["selectlive events info --device 123456"],
        }),
        download: leaf({
          name: "download",
          summary:
            "Preserve the retained event records and optionally decode them as CSV.",
          localEffects:
            "Creates a new acquisition directory containing raw records, a manifest, and optional CSV.",
          description:
            "Raw records and manifest are preserved before decoding. CSV requires --timezone.\n--start/--end filter only the exported CSV; the acquisition itself is bounded by --resume, not by dates.\n--resume names a previous manifest.json and reads only what is new. The previous capture's newest\nrecord is read again on purpose: seeing it proves nothing was missed in between. If it is GONE the\nmanifest says so — the inverter overwrote it, and those records are not recoverable.\nTimestamps are the device's own clock (epoch 2001-01-01), stored verbatim; the manifest also records\nthe clock's measured offset from ours, which is evidence, not a correction applied to the data.\nEach invocation creates a fresh directory; existing downloads are never overwritten.",
          // 🛑 NOT `--log`. `find` scores a leaf on its own words, and "--log" next to the required
          // "--out" made this the top hit for the query "log out", above `liveone auth logout` —
          // the same ranking accident commands.ts's `when:` note was written about. `--kind` names
          // the same choice and collides with nothing.
          flags: {
            ...device,
            out: {
              type: "string",
              required: true,
              help: "Parent directory for the new acquisition",
              schema: z.string().min(1),
            },
            kind: {
              type: "string",
              help: "Which of the two event logs to read (default: both)",
              values: ["alert", "operational", "both"],
              default: "both",
            },
            timezone: {
              type: "string",
              help: "Device clock's IANA timezone; required to produce CSV",
            },
            start: {
              type: "string",
              help: "Inclusive local start date (YYYY-MM-DD); filters the CSV",
              schema: V.date,
            },
            end: {
              type: "string",
              help: "Exclusive local end date (YYYY-MM-DD); filters the CSV",
              schema: V.date,
            },
            resume: {
              type: "string",
              help: "A previous acquisition's manifest.json, to read only what is new",
            },
          },
          exitCodes: {
            1: "raw records preserved, but incomplete, unsupported, not decoded, or the resume overlap was lost",
          },
          examples: [
            "selectlive events info --device 123456",
            "selectlive events download --device 123456 --out ./downloads --timezone Australia/Melbourne",
            "selectlive events download --device 123456 --out ./downloads --timezone Australia/Melbourne --resume ./downloads/selectlive-events-123456-ab12cd/manifest.json",
          ],
        }),
      },
    }),
  },
});
