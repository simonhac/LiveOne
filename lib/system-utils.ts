/**
 * Utility functions for system identification and formatting
 */

/**
 * Format system information for logging and display
 * @param system - System object with vendorType, vendorSiteId, and displayName
 * @returns Formatted string like "selectronic/1234 ('My Site')"
 */
export function formatSystemId(system: {
  vendorType: string;
  vendorSiteId: string;
  displayName: string;
}): string {
  return `${system.vendorType}/${system.vendorSiteId} ('${system.displayName}')`;
}
