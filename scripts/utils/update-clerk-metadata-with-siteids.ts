#!/usr/bin/env npx tsx

/**
 * Script to backup Clerk user metadata and ensure each credential has a systemId
 * This will:
 * 1. Fetch all users from Clerk
 * 2. Backup current metadata to a JSON file
 * 3. For each user's credentials, add the appropriate systemId
 * 4. Rename fields to correct names (systemId, vendorType)
 * 5. Reorder fields (systemId, vendorType, then alphabetical)
 * 6. Write updated metadata back to Clerk
 */

import * as dotenv from 'dotenv'
import * as path from 'path'

// Check if we're running in production mode
const isProduction = process.argv.includes('--production')

// Load environment variables from appropriate file
if (isProduction) {
  console.log('Running in PRODUCTION mode')
  dotenv.config({ path: path.resolve(process.cwd(), '.env.production') })
} else {
  console.log('Running in DEVELOPMENT mode')
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })
}

// Verify CLERK_SECRET_KEY is loaded
if (!process.env.CLERK_SECRET_KEY) {
  console.error('ERROR: CLERK_SECRET_KEY not found in environment')
  console.error('Please ensure CLERK_SECRET_KEY is set in .env.local')
  process.exit(1)
}

console.log(`CLERK_SECRET_KEY loaded: ${process.env.CLERK_SECRET_KEY.substring(0, 10)}...`)

import { createClerkClient } from '@clerk/nextjs/server'
import * as fs from 'fs'
import { db } from '@/lib/db'
import { systems } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

// Create Clerk client with explicit secret key
const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!
})

interface CredentialsMetadataV11 {
  version: string
  credentials: Array<any>
}

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const envPrefix = isProduction ? 'prod' : 'dev'
  const backupPath = path.join(process.cwd(), 'db-backups', `clerk-metadata-backup-${envPrefix}-${timestamp}.json`)

  console.log('Starting Clerk metadata update process...')
  console.log(`Backup will be saved to: ${backupPath}`)
  console.log('=' .repeat(80))

  try {
    // Fetch all users from Clerk
    console.log('\n1. Fetching all users from Clerk...')
    const userList = await clerkClient.users.getUserList({ limit: 100 })
    console.log(`   Found ${userList.data.length} users`)

    // Prepare backup data
    const backupData: any = {
      timestamp: new Date().toISOString(),
      totalUsers: userList.data.length,
      users: []
    }

    // Process each user
    console.log('\n2. Processing each user...')
    console.log('-'.repeat(80))

    for (const user of userList.data) {
      const userEmail = user.emailAddresses[0]?.emailAddress || 'unknown'
      const userName = user.username || userEmail
      console.log(`\nProcessing user: ${userName} (${user.id})`)

      // Backup current metadata
      const currentMetadata = user.privateMetadata
      backupData.users.push({
        id: user.id,
        username: userName,
        email: userEmail,
        originalMetadata: currentMetadata
      })

      // Check if metadata is in v1.1 format
      if (!currentMetadata?.version || !currentMetadata?.credentials) {
        console.log(`   ⚠️  User has no v1.1 metadata, skipping`)
        continue
      }

      const metadata = currentMetadata as unknown as CredentialsMetadataV11
      console.log(`   Found v1.1 metadata with ${metadata.credentials.length} credential(s)`)

      // Check each credential and update field names
      let needsUpdate = false
      const updatedCredentials = []

      for (const credential of metadata.credentials) {
        // First, rename fields and prepare for reordering
        let updatedCredential: any = {}
        let otherFields: any = {}

        // Get systemId (convert from various old field names)
        let systemId = credential.systemId || credential.liveoneSystemId || credential.liveoneSiteId
        if (!credential.systemId && (credential.liveoneSystemId !== undefined || credential.liveoneSiteId !== undefined)) {
          needsUpdate = true
        }

        // Get vendorType (rename from vendor if needed)
        const vendorType = credential.vendorType || credential.vendor
        if (credential.vendor && !credential.vendorType) {
          needsUpdate = true
        }

        // Collect all other fields (excluding old field names we're replacing)
        for (const key of Object.keys(credential)) {
          if (key !== 'vendor' && key !== 'vendorType' &&
              key !== 'liveoneSiteId' && key !== 'liveoneSystemId' &&
              key !== 'systemId') {
            otherFields[key] = credential[key]
          }
        }

        // Sort other fields alphabetically
        const sortedKeys = Object.keys(otherFields).sort()

        // Build the credential with correct field order
        // Use a new object to ensure order is preserved
        const orderedCredential: any = {}

        // First: systemId
        orderedCredential.systemId = systemId

        // Second: vendorType
        orderedCredential.vendorType = vendorType

        // Rest: in alphabetical order
        for (const key of sortedKeys) {
          orderedCredential[key] = otherFields[key]
        }

        // Replace updatedCredential with the ordered version
        updatedCredential = orderedCredential

        // Check if fields are out of order
        const originalKeys = Object.keys(credential)
        const expectedOrder = ['systemId', 'vendorType', ...sortedKeys]
        const currentOrder = originalKeys.filter(k =>
          k === 'systemId' || k === 'vendorType' || sortedKeys.includes(k)
        )
        if (JSON.stringify(currentOrder) !== JSON.stringify(expectedOrder)) {
          needsUpdate = true
        }

        const credentialVendor = updatedCredential.vendorType
        console.log(`   Checking ${credentialVendor} credential...`)

        // Manual mapping for production (since prod Clerk IDs don't match prod database)
        if (isProduction) {
          // Production manual mappings based on known relationships
          if (user.id === 'user_320RQvQkpGD7OUFhBQgirK8cAiW') { // craig
            if (credentialVendor === 'selectronic') {
              updatedCredential.systemId = 2; // Craig Home
              console.log(`      ✅ Manually set systemId: 2 (Craig Home) for production`);
              needsUpdate = true;
            } else if (credentialVendor === 'enphase' && updatedCredential.enphase_system_id === 364880) {
              updatedCredential.systemId = 3; // Jeffery Solar
              console.log(`      ✅ Manually set systemId: 3 (Jeffery Solar) for production`);
              needsUpdate = true;
            }
          } else if (user.id === 'user_320RNHYT03KKO3S7XB24AYZqlLc') { // simon
            if (credentialVendor === 'selectronic') {
              updatedCredential.systemId = 1; // Daylesford
              console.log(`      ✅ Manually set systemId: 1 (Daylesford) for production`);
              needsUpdate = true;
            } else if (credentialVendor === 'mondo' && updatedCredential.systemId === '8') {
              updatedCredential.systemId = 8; // Convert string to number
              console.log(`      ✅ Converted systemId to number: 8 for production`);
              needsUpdate = true;
            }
          }
        }
        // For Selectronic credentials, we need to find the corresponding system
        else if (credentialVendor === 'selectronic' || credentialVendor === 'select.live') {
          if (!updatedCredential.systemId || typeof updatedCredential.systemId === 'string') {
            if (updatedCredential.systemId) {
              console.log(`      ⚠️  Has systemId but it's a string (vendorSiteId), needs to be numeric system ID`)
            } else {
              console.log(`      ❌ Missing systemId!`)
            }

            // Try to find select.live/selectronic systems for this user
            // Note: Only select.live systems can use selectronic credentials
            const userSystems = await db
              .select()
              .from(systems)
              .where(eq(systems.ownerClerkUserId, user.id))

            // Filter for only select.live/selectronic systems
            const selectronicSystems = userSystems.filter(s =>
              s.vendorType === 'select.live' || s.vendorType === 'selectronic'
            )

            console.log(`      Found ${userSystems.length} total system(s), ${selectronicSystems.length} Selectronic system(s)`)

            if (selectronicSystems.length === 1) {
              // If user has exactly one selectronic system, use its ID (not vendorSiteId)
              updatedCredential.systemId = selectronicSystems[0].id
              console.log(`      ✅ Added systemId: ${updatedCredential.systemId} (${selectronicSystems[0].displayName})`)
              needsUpdate = true
            } else if (selectronicSystems.length > 1) {
              // Multiple selectronic systems - need manual intervention
              console.log(`      ⚠️  User has multiple Selectronic systems, need manual intervention:`)
              for (const sys of selectronicSystems) {
                console.log(`         - System ${sys.id}: ${sys.displayName} (vendorSiteId: ${sys.vendorSiteId})`)
              }
              console.log(`      ⏭️  Skipping automatic update for user with multiple Selectronic systems`)
            } else if (selectronicSystems.length === 0) {
              console.log(`      ⚠️  No Selectronic systems found for user, cannot determine systemId`)
              if (userSystems.length > 0) {
                console.log(`      ℹ️  User has non-Selectronic systems:`)
                for (const sys of userSystems.filter(s => s.vendorType !== 'select.live' && s.vendorType !== 'selectronic')) {
                  console.log(`         - System ${sys.id}: ${sys.displayName} (type: ${sys.vendorType})`)
                }
              }
            }
          } else if (typeof updatedCredential.systemId === 'number') {
            console.log(`      ✅ Already has systemId: ${updatedCredential.systemId}`)
          }
        } else if (credentialVendor === 'enphase') {
          // Enphase credentials - find the matching system by vendor_site_id
          if (!updatedCredential.systemId || typeof updatedCredential.systemId === 'string') {
            // Find the Enphase system for this user
            const userSystems = await db
              .select()
              .from(systems)
              .where(eq(systems.ownerClerkUserId, user.id))

            const enphaseSystem = userSystems.find(s =>
              s.vendorType === 'enphase' &&
              (s.vendorSiteId === updatedCredential.enphase_system_id ||
               s.vendorSiteId === updatedCredential.systemId)
            )

            if (enphaseSystem) {
              updatedCredential.systemId = enphaseSystem.id
              console.log(`      ✅ Added systemId: ${updatedCredential.systemId} (${enphaseSystem.displayName})`)
              needsUpdate = true
            } else {
              console.log(`      ⚠️  Cannot find matching Enphase system`)
            }
          } else if (typeof updatedCredential.systemId === 'number') {
            console.log(`      ✅ Already has systemId: ${updatedCredential.systemId}`)
          }
        } else if (credentialVendor === 'mondo') {
          // Mondo credentials - find the matching system
          if (!updatedCredential.systemId || typeof updatedCredential.systemId === 'string') {
            // Find the Mondo system for this user
            const userSystems = await db
              .select()
              .from(systems)
              .where(eq(systems.ownerClerkUserId, user.id))

            const mondoSystems = userSystems.filter(s => s.vendorType === 'mondo')

            if (mondoSystems.length === 1) {
              updatedCredential.systemId = mondoSystems[0].id
              console.log(`      ✅ Added systemId: ${updatedCredential.systemId} (${mondoSystems[0].displayName})`)
              needsUpdate = true
            } else if (mondoSystems.length > 1) {
              console.log(`      ⚠️  Multiple Mondo systems found, manual intervention needed`)
            } else {
              // Try to convert string ID to number if it matches
              if (typeof updatedCredential.systemId === 'string') {
                const sysId = parseInt(updatedCredential.systemId)
                if (!isNaN(sysId)) {
                  updatedCredential.systemId = sysId
                  console.log(`      ✅ Converted systemId to number: ${sysId}`)
                  needsUpdate = true
                }
              } else {
                console.log(`      ⚠️  No Mondo system found for user`)
              }
            }
          } else if (typeof updatedCredential.systemId === 'number') {
            console.log(`      ✅ Has systemId: ${updatedCredential.systemId}`)
          }
        }

        updatedCredentials.push(updatedCredential)
      }

      // Update metadata if needed
      if (needsUpdate) {
        console.log(`   📝 Updating metadata for user ${userName}...`)

        const updatedMetadata: CredentialsMetadataV11 = {
          version: metadata.version,
          credentials: updatedCredentials
        }

        try {
          await clerkClient.users.updateUser(user.id, {
            privateMetadata: updatedMetadata as unknown as Record<string, unknown>
          })
          console.log(`   ✅ Successfully updated metadata`)

          // Add updated metadata to backup
          const userBackup = backupData.users.find((u: any) => u.id === user.id)
          if (userBackup) {
            userBackup.updatedMetadata = updatedMetadata
            userBackup.wasUpdated = true
          }
        } catch (error) {
          console.error(`   ❌ Failed to update metadata:`, error)
        }
      } else {
        console.log(`   ℹ️  No updates needed`)
      }
    }

    // Save backup
    console.log('\n' + '='.repeat(80))
    console.log('3. Saving backup...')
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2))
    console.log(`   ✅ Backup saved to: ${backupPath}`)

    // Summary
    console.log('\n' + '='.repeat(80))
    console.log('SUMMARY:')
    console.log(`  Total users processed: ${backupData.users.length}`)
    const updatedCount = backupData.users.filter((u: any) => u.wasUpdated).length
    console.log(`  Users updated: ${updatedCount}`)
    console.log(`  Backup file: ${backupPath}`)

    // Final verification - check all credentials have systemId
    console.log('\n' + '='.repeat(80))
    console.log('4. Final Verification - Checking all credentials for systemId...')
    console.log('-'.repeat(80))

    let allCredentialsValid = true
    const missingSystemIds: any[] = []

    // Re-fetch all users to get current state after updates
    const finalUserList = await clerkClient.users.getUserList({ limit: 100 })

    for (const user of finalUserList.data) {
      const userEmail = user.emailAddresses[0]?.emailAddress || 'unknown'
      const userName = user.username || userEmail

      if (!user.privateMetadata?.version || !user.privateMetadata?.credentials) {
        continue // Skip users without v1.1 metadata
      }

      const metadata = user.privateMetadata as unknown as CredentialsMetadataV11

      for (const credential of metadata.credentials) {
        if (!credential.systemId || typeof credential.systemId !== 'number') {
          allCredentialsValid = false
          missingSystemIds.push({
            user: userName,
            userId: user.id,
            vendor: credential.vendorType || credential.vendor,
            email: credential.email || 'N/A',
            currentValue: credential.systemId || credential.liveoneSystemId || credential.liveoneSiteId || 'none'
          })
        }
      }
    }

    if (allCredentialsValid) {
      console.log('✅ SUCCESS: All credentials have systemId set with correct numeric IDs!')
    } else {
      console.log('❌ WARNING: Some credentials are still missing or have incorrect systemId:')
      console.log('')
      for (const missing of missingSystemIds) {
        console.log(`   User: ${missing.user} (${missing.userId})`)
        console.log(`   Vendor: ${missing.vendor}`)
        console.log(`   Credential: ${missing.email}`)
        console.log(`   Current value: ${missing.currentValue}`)
        console.log('')
      }
      console.log('These credentials need manual intervention to set the appropriate systemId')
    }

    console.log('='.repeat(80))

  } catch (error) {
    console.error('Fatal error:', error)
    process.exit(1)
  }
}

// Run the script
main().catch(console.error)