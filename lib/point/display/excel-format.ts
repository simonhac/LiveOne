/**
 * Minimal Excel-style number-format interpreter.
 *
 * Point display precision/units live in per-device-type JSON manifests (see ./registry) using
 * Excel-style format strings, so tweaking a point's display is a one-line data edit. This applies the
 * common subset we use:
 *   "0"       → integer            0 dp        (50   → "50")
 *   "0.0"     → 1 decimal place                (50   → "50.0")
 *   "0.00"    → 2 decimal places               (1.5  → "1.50")
 *   "#,##0"   → grouped thousands              (12345 → "12,345")
 *   "#,##0.0" → grouped + 1 dp                 (12345.6 → "12,345.6")
 *   "0%"      → percent, 0 dp                  (0.5  → "50%")
 *   "0.0%"    → percent, 1 dp                  (0.5  → "50.0%")
 * Anything else falls back to `String(value)`. Decimals = count of `0`/`#` placeholders after the
 * decimal point; grouping = a comma in the integer part; percent = a `%` anywhere in the format.
 */
export function applyExcelFormat(
  value: number,
  format?: string | null,
): string {
  if (value == null || Number.isNaN(value)) return "";
  if (!format) return String(value);

  const isPercent = format.includes("%");
  const core = format.replace(/%/g, "");
  const scaled = isPercent ? value * 100 : value;

  const dot = core.indexOf(".");
  const decimals =
    dot === -1 ? 0 : (core.slice(dot + 1).match(/[0#]/g) ?? []).length;
  const intPart = dot === -1 ? core : core.slice(0, dot);
  const grouping = intPart.includes(",");

  const fixed = scaled.toFixed(decimals);
  let out: string;
  if (grouping) {
    const neg = fixed.startsWith("-");
    const body = neg ? fixed.slice(1) : fixed;
    const [i, f] = body.split(".");
    const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    out = (neg ? "-" : "") + grouped + (f ? "." + f : "");
  } else {
    out = fixed;
  }
  return isPercent ? out + "%" : out;
}
