/**
 * Utilities for working with series filter patterns
 */

/**
 * Split a comma-separated string in a brace-aware way
 * Commas inside braces are not treated as separators
 *
 * @param str - String to split
 * @returns Array of patterns
 *
 * @example
 * splitBraceAware("a,b,c.{d,e},f") => ["a", "b", "c.{d,e}", "f"]
 *
 * @example
 * splitBraceAware("source.solar/*,bidi.battery/soc.{avg,min,max}")
 * => ["source.solar/*", "bidi.battery/soc.{avg,min,max}"]
 */
export function splitBraceAware(str: string): string[] {
  const result: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (char === "{") {
      braceDepth++;
      current += char;
    } else if (char === "}") {
      braceDepth--;
      current += char;
    } else if (char === "," && braceDepth === 0) {
      // Comma at top level - treat as separator
      if (current.trim().length > 0) {
        result.push(current.trim());
      }
      current = "";
    } else {
      current += char;
    }
  }

  // Add final pattern
  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
}
