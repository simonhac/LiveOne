/**
 * Utility functions for device identification and formatting
 */

/**
 * Format device information for logging and display
 * @param device - Device object with vendorType, vendorSiteId, and displayName
 * @returns Formatted string like "selectronic/1234 ('My Site')"
 */
export function formatSystemId(device: {
  vendorType: string;
  vendorSiteId: string;
  displayName: string;
}): string {
  return `${device.vendorType}/${device.vendorSiteId} ('${device.displayName}')`;
}
