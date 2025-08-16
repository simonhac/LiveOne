/**
 * Format number according to OpenNEM precision rules
 */

export function formatPrecision(value: number, minSigFigs: number = 4): number {
  /**
   * Format number according to OpenNEM precision rules:
   * - Maintain minimum significant figures (default 4)
   * - Preserve all digits left of decimal point
   * - Include decimals only when precision is needed
   * - Remove trailing zeros after decimal place
   * 
   * Examples:
   * - 1234.5678 → 1235
   * - 123.456 → 123.5
   * - 1000.0 → 1000
   * - 12.3456 → 12.35
   * - 0.123456 → 0.1235
   */
  
  if (value === 0) {
    return 0;
  }
  
  // Calculate the order of magnitude
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  
  // Calculate decimal places needed based on significant figures
  const decimalPlaces = Math.max(0, minSigFigs - 1 - magnitude);
  
  // Round to specified significant figures
  const factor = Math.pow(10, decimalPlaces);
  const rounded = Math.round(value * factor) / factor;
  
  // If it's effectively an integer (accounting for floating point precision), return as integer
  if (Math.abs(rounded - Math.round(rounded)) < 1e-10) {
    return Math.round(rounded);
  }
  
  // Otherwise return the rounded float
  // Parse and re-format to remove trailing zeros
  const strVal = rounded.toFixed(decimalPlaces);
  return parseFloat(strVal);
}

/**
 * Format an array of numbers for OpenNEM
 */
export function formatDataArray(data: (number | null)[]): (number | null)[] {
  return data.map(value => {
    if (value === null) return null;
    return formatPrecision(value);
  });
}