/**
 * Arg shapes and flag groups shared across `dashboard` verbs.
 *
 * Declared once so a documented flag and an accepted flag cannot drift apart.
 */
import { z } from "zod";

export const DASH_ARG = {
  name: "dash",
  required: true,
  help: "A dashboard: its db_… id or its slug",
} as const;

export const NODE_ARG = {
  name: "node",
  required: true,
  help: "The n_… id of the node, as printed by `show`",
} as const;

/**
 * Transport selection, on EVERY verb. `http` is the default — the deployed API, as you, via
 * `liveone auth login`. `db` is explicit-only and keeps its own credential story
 * (MIGRATE_DATABASE_URL / the liveone:dev fallback); an ambient env var never silently chooses
 * the target.
 */
export const TRANSPORT_FLAGS = {
  via: {
    type: "string",
    values: ["http", "db"],
    default: "http",
    help: "How to reach the data: the deployed API (http) or Postgres directly (db)",
  },
  baseUrl: {
    type: "string",
    placeholder: "origin",
    help: "http only: target origin (default: your stored default, else https://www.liveone.energy)",
  },
} as const;

export const POSITION_FLAGS = {
  parent: {
    type: "string",
    placeholder: "n_id",
    help: "Insert inside this group (default: the root)",
  },
  index: {
    type: "number",
    placeholder: "k",
    schema: z.number().int().min(0),
    hint: "0-based position among the parent's children",
    help: "Position within the parent (default: append)",
  },
  before: {
    type: "string",
    placeholder: "n_id",
    help: "Insert immediately before this sibling",
  },
  after: {
    type: "string",
    placeholder: "n_id",
    help: "Insert immediately after this sibling",
  },
} as const;

export const ENVELOPE_FLAGS = {
  area: {
    type: "string",
    placeholder: "ar_id",
    help: "Bind the node to an area (scope-bearing; readability is NOT checked)",
  },
  device: {
    type: "string",
    placeholder: "dv_id",
    help: "Bind the node to a device (scope-bearing; readability is NOT checked)",
  },
  hidden: { type: "boolean", help: "Mark the node hidden" },
  columns: {
    type: "number",
    placeholder: "1-12",
    schema: z.number().int().min(1).max(12),
    hint: "1–12 on the 12-column grid",
    help: "Width hint",
  },
} as const;
