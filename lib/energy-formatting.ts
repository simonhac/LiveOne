/**
 * Energy formatting utilities for LiveOne
 * Pure functions with no JSX dependencies for easy testing
 */

export type FormattedValue = {
  value: string
  unit: string
}

export type FormattedValuePair = {
  value: string
  unit: string
}

/**
 * Parse a unit string to extract the SI prefix and base unit
 * @param unit - The unit string (e.g., 'kW', 'MWh', 'W', 'Wh')
 * @returns Object with prefix ('k', 'M', 'G', or '') and baseUnit ('W', 'Wh', etc.)
 */
function parseUnit(unit: string): { prefix: string; baseUnit: string } {
  // Check for common SI prefixes
  if (unit.startsWith('G')) return { prefix: 'G', baseUnit: unit.slice(1) }
  if (unit.startsWith('M')) return { prefix: 'M', baseUnit: unit.slice(1) }
  if (unit.startsWith('k')) return { prefix: 'k', baseUnit: unit.slice(1) }
  return { prefix: '', baseUnit: unit }
}

/**
 * Convert a value from one SI prefix to base units
 * @param value - The numeric value
 * @param prefix - The SI prefix ('k', 'M', 'G', or '')
 */
function toBaseUnits(value: number, prefix: string): number {
  switch (prefix) {
    case 'G': return value * 1000000000
    case 'M': return value * 1000000
    case 'k': return value * 1000
    default: return value
  }
}

/**
 * Convert a value from base units to a specific SI prefix
 * @param value - The numeric value in base units
 * @param prefix - The target SI prefix ('k', 'M', 'G', or '')
 */
function fromBaseUnits(value: number, prefix: string): number {
  switch (prefix) {
    case 'G': return value / 1000000000
    case 'M': return value / 1000000
    case 'k': return value / 1000
    default: return value
  }
}

/**
 * Get appropriate SI prefix based on value magnitude in base units
 */
function getAppropriateSIPrefix(baseValue: number): string {
  const absValue = Math.abs(baseValue)
  if (absValue >= 1000000000) return 'G'  // 1 GW or more
  if (absValue >= 1000000) return 'M'      // 1 MW or more
  return 'k'                               // Less than 1 MW, use kW
}

/**
 * Format a single value with its unit
 * @param value - The numeric value
 * @param unit - The unit string (e.g., 'W', 'kW', 'kWh', 'MWh')
 */
export function formatValue(value: number | null | undefined, unit: string): FormattedValue {
  if (value === null || value === undefined) {
    return { value: '—', unit: '' }
  }
  
  const { prefix: inputPrefix, baseUnit } = parseUnit(unit)
  const baseValue = toBaseUnits(value, inputPrefix)
  const outputPrefix = getAppropriateSIPrefix(baseValue)
  const outputValue = fromBaseUnits(baseValue, outputPrefix)
  
  return { 
    value: outputValue.toFixed(1), 
    unit: `${outputPrefix}${baseUnit}` 
  }
}

/**
 * Format a pair of values with their unit
 * @param inValue - The first (in) value
 * @param outValue - The second (out) value
 * @param unit - The unit string (e.g., 'W', 'kW', 'kWh', 'MWh')
 */
export function formatValuePair(inValue: number | null | undefined, outValue: number | null | undefined, unit: string): FormattedValuePair {
  // If both are null/undefined, show "—/—"
  if ((inValue === null || inValue === undefined) && (outValue === null || outValue === undefined)) {
    return { value: '—/—', unit: '' }
  }
  
  const { prefix: inputPrefix, baseUnit } = parseUnit(unit)
  
  // If in is null/undefined, show "—/outValue unit"
  if (inValue === null || inValue === undefined) {
    const baseOutValue = toBaseUnits(outValue!, inputPrefix)
    const outputPrefix = getAppropriateSIPrefix(baseOutValue)
    const outputOutValue = fromBaseUnits(baseOutValue, outputPrefix)
    return { 
      value: `—/${outputOutValue.toFixed(1)}`, 
      unit: `${outputPrefix}${baseUnit}` 
    }
  }
  
  // If out is null/undefined, show "inValue/— unit"
  if (outValue === null || outValue === undefined) {
    const baseInValue = toBaseUnits(inValue, inputPrefix)
    const outputPrefix = getAppropriateSIPrefix(baseInValue)
    const outputInValue = fromBaseUnits(baseInValue, outputPrefix)
    return { 
      value: `${outputInValue.toFixed(1)}/—`, 
      unit: `${outputPrefix}${baseUnit}` 
    }
  }
  
  // Both values exist - use the unit of the larger value for both
  const baseInValue = toBaseUnits(inValue, inputPrefix)
  const baseOutValue = toBaseUnits(outValue, inputPrefix)
  const maxBaseValue = Math.max(Math.abs(baseInValue), Math.abs(baseOutValue))
  const outputPrefix = getAppropriateSIPrefix(maxBaseValue)
  
  const outputInValue = fromBaseUnits(baseInValue, outputPrefix)
  const outputOutValue = fromBaseUnits(baseOutValue, outputPrefix)
  
  return { 
    value: `${outputInValue.toFixed(1)}/${outputOutValue.toFixed(1)}`, 
    unit: `${outputPrefix}${baseUnit}` 
  }
}