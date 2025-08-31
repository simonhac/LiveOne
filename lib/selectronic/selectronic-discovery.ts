/**
 * Select.Live system discovery
 * Authenticates with Select.Live and discovers all available systems
 */

import { SelectronicFetchClient } from './selectronic-client'
import fetch from 'node-fetch'

export interface SelectLiveSystem {
  name: string
  systemNumber?: number
  lat: number
  lng: number
  role: 'owner' | 'installer'
}

export interface DiscoveryResult {
  success: boolean
  systems?: SelectLiveSystem[]
  error?: string
}

/**
 * Discover all systems available to a Select.Live account
 */
export async function discoverSelectLiveSystems(
  email: string,
  password: string
): Promise<DiscoveryResult> {
  try {
    console.log('[Discovery] Starting Select.Live system discovery...')
    
    // Step 1: Use existing SelectronicFetchClient for authentication
    const client = new SelectronicFetchClient({
      email,
      password,
      systemNumber: '0' // Dummy system number for auth only
    })
    
    // Authenticate
    const authSuccess = await client.authenticate()
    if (!authSuccess) {
      console.error('[Discovery] Authentication failed')
      return {
        success: false,
        error: 'Authentication failed - check credentials'
      }
    }
    
    console.log('[Discovery] Authentication successful')
    
    // Get the cookie string from the client
    const cookieString = client.getCookieString()

    // Step 2: Fetch systems from both endpoints
    const systemsMap = new Map<string, SelectLiveSystem>()

    // Fetch installer systems
    try {
      console.log('[Discovery] Fetching installer systems...')
      const installerResponse = await fetch('https://select.live/systems/list/installer', {
        headers: {
          'Cookie': cookieString,
          'Accept': 'application/json',
          'User-Agent': 'LiveOne/1.0',
        },
      })

      if (installerResponse.ok) {
        const installerData = await installerResponse.json()
        if (installerData.systems && Array.isArray(installerData.systems)) {
          installerData.systems.forEach((system: any) => {
            if (system.name) {
              systemsMap.set(system.name, {
                name: system.name,
                systemNumber: system.did ? parseInt(system.did) : undefined,
                lat: parseFloat(system.lat),
                lng: parseFloat(system.lng),
                role: 'installer'
              })
            }
          })
          console.log(`[Discovery] Found ${installerData.systems.length} installer systems`)
        }
      } else {
        console.log('[Discovery] No installer access or empty response')
      }
    } catch (error) {
      console.log('[Discovery] Error fetching installer systems:', error)
    }

    // Fetch owner systems
    try {
      console.log('[Discovery] Fetching owner systems...')
      const ownerResponse = await fetch('https://select.live/systems/list/owner', {
        headers: {
          'Cookie': cookieString,
          'Accept': 'application/json',
          'User-Agent': 'LiveOne/1.0',
        },
      })

      if (ownerResponse.ok) {
        const ownerData = await ownerResponse.json()
        if (ownerData.systems && Array.isArray(ownerData.systems)) {
          ownerData.systems.forEach((system: any) => {
            if (system.name) {
              // Owner role takes precedence over installer
              systemsMap.set(system.name, {
                name: system.name,
                systemNumber: system.did ? parseInt(system.did) : undefined,
                lat: parseFloat(system.lat),
                lng: parseFloat(system.lng),
                role: 'owner'
              })
            }
          })
          console.log(`[Discovery] Found ${ownerData.systems.length} owner systems`)
        }
      } else {
        console.log('[Discovery] No owner access or empty response')
      }
    } catch (error) {
      console.log('[Discovery] Error fetching owner systems:', error)
    }

    // Convert map to array
    const systems = Array.from(systemsMap.values())
    
    if (systems.length === 0) {
      return {
        success: false,
        error: 'No systems found for this account'
      }
    }

    console.log(`[Discovery] Total unique systems found: ${systems.length}`)
    return {
      success: true,
      systems
    }

  } catch (error) {
    console.error('[Discovery] Error during discovery:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during discovery'
    }
  }
}

/**
 * Test the discovery with provided credentials
 */
export async function testDiscovery(email: string, password: string): Promise<void> {
  console.log('Testing Select.Live discovery...')
  console.log(`Email: ${email}`)
  
  const result = await discoverSelectLiveSystems(email, password)
  
  if (result.success && result.systems) {
    console.log('\n✅ Discovery successful!')
    console.log(`Found ${result.systems.length} systems:\n`)
    
    result.systems.forEach((system, index) => {
      console.log(`${index + 1}. ${system.name}`)
      console.log(`   System Number: ${system.systemNumber || 'Not available'}`)
      console.log(`   Role: ${system.role}`)
      console.log(`   Location: ${system.lat}, ${system.lng}`)
      console.log('')
    })
  } else {
    console.error('\n❌ Discovery failed:', result.error)
  }
}