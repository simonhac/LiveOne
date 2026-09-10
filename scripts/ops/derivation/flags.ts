/**
 * Flag groups shared across `derivation` verbs.
 *
 * Declared once so the window a reader accepts and the window a writer accepts cannot drift — the
 * sort of skew that is invisible until a recompute silently covers a different range than the list
 * that justified it.
 */
import { V } from "@/lib/cli/cli";

export const WINDOW_FLAGS = {
  last: {
    type: "string",
    placeholder: "30d",
    help: "Relative window ending now",
  },
  date: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "A single UTC day",
  },
  start: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "Window start (UTC)",
  },
  end: {
    type: "string",
    placeholder: "YYYY-MM-DD",
    schema: V.date,
    help: "Window end, inclusive (UTC)",
  },
} as const;
