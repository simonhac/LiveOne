/**
 * Code -> label tables for the SP PRO's two event logs and the coded state fields carried in each
 * event record.
 *
 * These are interoperability facts: without them a stored event is an integer, and the whole point
 * of retaining the logs is being able to read "Main DC Supply Cable Open Circuit Fault" a month
 * later. They were resolved by offline IL inspection of SP LINK 16.11.9663's enum switches; the
 * provenance (software version, assembly hash, method) travels with the table itself, in
 * `event-labels.json`. No vendor binaries or decompiled source are in this repository — see
 * NOTICE.md.
 *
 * 🛑 An unknown code is reported as `UNDECODED(n)`, never guessed and never dropped. A label that
 * is blank in the vendor table stays blank: "the vendor has no name for this code" and "we could
 * not find the code" are different answers.
 */
import labels from "./event-labels.json";

export type LabelSet =
  | "alertEvent"
  | "operationalEvent"
  | "generatorStatus"
  | "generatorReason"
  | "contactorState"
  | "inverterMode"
  | "chargerStatus";

export interface LabelProvenance {
  vendorSoftware: string;
  assemblySha256: string;
  installerSha256: string;
  method: string;
  note: string;
}

const TABLES = labels as unknown as Record<string, Record<string, string>> & {
  $provenance: LabelProvenance;
};

export const labelProvenance: LabelProvenance = TABLES.$provenance;

/** The label for a code, or `UNDECODED(n)` when the table does not carry it. */
export function label(set: LabelSet, code: number): string {
  const table = TABLES[set];
  const value = table?.[String(code)];
  return value === undefined ? `UNDECODED(${code})` : value;
}

/** Whether the table carries this code at all — the flag a caller needs to keep raw evidence. */
export function known(set: LabelSet, code: number): boolean {
  return TABLES[set]?.[String(code)] !== undefined;
}
