import { cache } from 'react'
import { SystemsManager } from './systems-manager'

/**
 * Get a cached SystemsManager instance for the current request.
 * This ensures we only load systems from the database once per request,
 * even if multiple components need access to system data.
 */
export const getSystemsManager = cache(() => {
  return new SystemsManager()
})