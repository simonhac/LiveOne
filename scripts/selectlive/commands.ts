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
const leaf = (spec: CommandSpec) =>
  defineCommand({
    uses: ["selectlive"],
    when: spec.summary,
    ...spec,
  });
export const selectliveCommand = defineCommand({
  name: "selectlive",
  summary: "Explore an SP PRO inverter through Select.live.",
  when: "Authenticate, list inverters, inspect memory, or preserve retained detailed history through the SP LINK tunnel.",
  description:
    "Independent of LiveOne's API and database. Device commands read data; only inverter authentication writes are permitted.\nCredentials are saved locally by auth. Downloads create a new local directory. Neither operation needs --apply.",
  uses: ["selectlive"],
  handlesInterrupt: true,
  localEffects:
    "auth updates local credentials; history download creates local files. Inverter settings are not changed.",
  examples: [
    "selectlive auth",
    "selectlive devices",
    "selectlive history download --device 123456 --out ./downloads --timezone Australia/Melbourne",
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
  },
});
